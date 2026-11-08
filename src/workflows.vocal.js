"use strict";
/**
 * AI 翻唱工作流（需求报告 附录 V）。
 *
 * 三条链路全部跑在**本机 192.168.0.128** 的 ComfyUI（config.comfy.instances 里
 * id = "comfyui:local" 的那台）上，因为权重只在这台机器上：
 *   · RVC 音色模型（models/TTS/RVC/*.pth）与 hubert（content-vec-best）
 *   · Demucs 人声/伴奏分离（torchaudio HDEMUCS_HIGH_MUSDB_PLUS，权重已在
 *     %USERPROFILE%\.cache\torch\hub\checkpoints 里）
 *   · ACE-Step 1.5 一体化权重（ace_step_1.5_turbo_aio.safetensors + scragvae_comfyui）
 *
 * 所以这三个工作流都声明 instances: ["comfyui:local"]：
 * 调度器只会把它们派给本机那台，也绝不会把通用工作流派过去（那边的模型不一样）。
 */

const { M } = require("./workflows.image");

/** 本机 ComfyUI 实例 id（config.json 里 comfy.instances 的 id） */
const LOCAL_INSTANCE = "comfyui:local";
/** 默认音色（本机自带的 RVC 模型；界面上还能选到更多） */
const DEFAULT_VOICE = "local:xiaomaizi_v2_48k.pth";
/** ACE-Step 1.5 一体化权重（checkpoints 目录） */
const ACE_CKPT = "ace_step_1.5_turbo_aio.safetensors";
/** ACE-Step 1.5 的音频 VAE（vae 目录） */
const ACE_VAE = "scragvae_comfyui.safetensors";

const seed = (ctx) => (Number.isFinite(ctx.params.seed) && ctx.params.seed >= 0
  ? Math.floor(ctx.params.seed)
  : Math.floor(Math.random() * 2 ** 40));

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * 音色名 → 安全的模型文件名（训练节点自己也会再 slug 一次，这里先挡住路径分隔符与怪字符，
 * 免得用户填「我的/音色」这种名字时两头对不上）。
 */
const voiceNameOf = (raw, fallback = "MyVoice") => {
  const s = String(raw || "").trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
  const cut = s.slice(0, 40).replace(/^_+|_+$/g, "");
  return cut || fallback;
};

/** 训练用的采样率：只有 32k / 40k / 48k 三档，默认 48k（本机预训练权重就是 48k 那套） */
const TRAIN_RATES = { "32k": 32000, "40k": 40000, "48k": 48000 };
const trainRateOf = (v) => (TRAIN_RATES[String(v || "").trim()] ? String(v).trim() : "48k");

/** 歌曲音轨：优先 refs.audio，其次 refs.speech / 素材库里的任意音频 */
const songAudio = (ctx) => ctx.audios.audio || ctx.audios.voice || ctx.audios.speech || (ctx.audioList || [])[0] || null;

const vocalWorkflows = {

  // ==================================================== WF-28 RVC 换音色翻唱
  //
  // 图：LoadAudio(原曲) → AudioSeparation(Demucs) → 三个伴奏轨相加
  //     → 人声轨 → UnifiedVoiceChanger(RVC 引擎 + RVC 音色模型) → 与伴奏混音 → MP3
  //
  // 这是"真翻唱"：旋律、节奏、咬字全部保留，只把人声的音色换成目标模型。
  "WF-28": {
    id: "WF-28",
    label: "AI 翻唱 · 换音色（RVC）",
    kind: "audio",
    engine: "rvc",
    mode: "cover",
    fps: null,
    hasAudio: true,
    vramClass: "heavy",
    vramNeedMB: 12000,
    maxDurationS: 900,
    instances: [LOCAL_INSTANCE],
    machine: "本机 192.168.0.128",
    supports: { voiceConvert: true, refAudios: 1 },
    defaults: { voice_model: DEFAULT_VOICE, pitch: 0, index_ratio: 0.75, consonant_protection: 0.25, volume_envelope: 0.25 },
    build(ctx) {
      const song = songAudio(ctx);
      if (!song) throw Object.assign(new Error("翻唱需要 1 段歌曲音频（refs.audio）"), { code: "PARAM_INVALID" });
      const voice = String(ctx.params.voice_model || DEFAULT_VOICE);
      const gainVocal = clamp(ctx.params.vocal_gain_db, -24, 12, 0);
      const gainInst = clamp(ctx.params.inst_gain_db, -24, 12, 0);
      const wf = {
        // 原曲（已由 jobs.buildContext 上传到 ComfyUI 的 input 目录）
        "1": { class_type: "LoadAudio", inputs: { audio: song } },
        // 人声 / 伴奏分离：0=Bass 1=Drums 2=Other 3=Vocals
        "2": { class_type: "AudioSeparation", inputs: {
          audio: ["1", 0], chunk_fade_shape: "half_sine", chunk_length: 16, chunk_overlap: 0.1 } },
        "3": { class_type: "AudioCombine", inputs: { audio_1: ["2", 0], audio_2: ["2", 1], method: "add" } },
        "4": { class_type: "AudioCombine", inputs: { audio_1: ["3", 0], audio_2: ["2", 2], method: "add" } },
        // 伴奏音量（默认 0dB，不动）
        "5": { class_type: "AudioAdjustVolume", inputs: { audio: ["4", 0], volume: gainInst } },
        // RVC 音色模型 + 引擎参数
        "6": { class_type: "LoadRVCModelNode", inputs: { model: voice, index_mode: "auto", index_file: "", auto_download: false } },
        "7": { class_type: "RVCEngineNode", inputs: {
          pitch: clamp(ctx.params.pitch, -14, 14, 0),
          index_ratio: clamp(ctx.params.index_ratio, 0, 1, 0.75),
          consonant_protection: clamp(ctx.params.consonant_protection, 0, 0.5, 0.25),
          volume_envelope: clamp(ctx.params.volume_envelope, 0, 1, 0.25),
          hubert_model: "content-vec-best: Content Vec 768 (Recommended)",
          output_sample_rate: 44100,
          enable_custom_chunking: false,
          device: "cuda" } },
        // 换音色：narrator_target 收的是 LoadRVCModelNode 的 RVC_MODEL
        "8": { class_type: "UnifiedVoiceChangerNode", inputs: {
          TTS_engine: ["7", 0], source_audio: ["2", 3], narrator_target: ["6", 0],
          refinement_passes: 1, max_chunk_duration: 60, chunk_method: "smart" } },
        "9": { class_type: "AudioAdjustVolume", inputs: { audio: ["8", 0], volume: gainVocal } },
        // 人声 + 伴奏：overlay 是带增益补偿的叠加，不会一混就爆音
        "10": { class_type: "MergeAudioNode", inputs: {
          audio1: ["9", 0], audio2: ["5", 0], merge_algorithm: "overlay",
          sample_rate: 44100, normalize: true, crossfade_duration: 0.1, volume_balance: 0.5,
          vocal_pitch_shift: 0, instrumental_pitch_shift: 0, enable_pitch_control: false } },
        "11": { class_type: "SaveAudioMP3", inputs: {
          audio: ["10", 0], filename_prefix: `${ctx.prefix}_cover`, quality: "320k" } },
      };
      return wf;
    },
  },

  // ============================================ WF-29 AI 重唱 / 换风格（ACE-Step 1.5）
  //
  // 图：CheckpointLoader(ace_step_1.5_turbo_aio) + VAELoader(scragvae)
  //     → TextEncodeAceStepAudio1.5(风格 tags + 歌词)
  //     → [参考音频 → VAEEncodeAudio → ReferenceTimbreAudio 给音色]
  //     → KSampler → VAEDecodeAudio → MP3
  //
  // 参考音频就是原曲：ACE-Step 1.5 会沿用它的音色与编曲感，按新歌词重新演唱，
  // 也就是"同一首歌换唱法 / 换风格 / 换成自己填的词"。
  "WF-29": {
    id: "WF-29",
    label: "AI 翻唱 · 整首重唱（ACE-Step 1.5）",
    kind: "audio",
    engine: "ace_step_1.5",
    mode: "resing",
    fps: null,
    hasAudio: true,
    vramClass: "heavy",
    vramNeedMB: 24000,
    maxDurationS: 600,
    instances: [LOCAL_INSTANCE],
    machine: "本机 192.168.0.128",
    supports: { text2music: true, refAudios: 1 },
    defaults: { bpm: 120, seconds: 180, language: "zh", keyscale: "C major", timesignature: "4", steps: 8, cfg: 1 },
    build(ctx) {
      const seconds = clamp(ctx.params.seconds ?? ctx.params.duration_s, 5, 600, 180);
      const bpm = Math.round(clamp(ctx.params.bpm, 10, 300, 120));
      const ref = ctx.params.use_reference === false ? null : songAudio(ctx);
      const tags = String(ctx.params.tags || ctx.params.music_caption || ctx.prompt || "流行, 短视频, 干净人声").trim();
      const lyrics = String(ctx.params.lyrics || "").trim();
      const wf = {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ACE_CKPT } },
        "2": { class_type: "VAELoader", inputs: { vae_name: ACE_VAE } },
        "5": { class_type: "TextEncodeAceStepAudio1.5", inputs: {
          clip: ["1", 1], tags, lyrics, seed: seed(ctx), bpm,
          duration: seconds,
          timesignature: String(ctx.params.timesignature || "4"),
          language: String(ctx.params.language || "zh"),
          keyscale: String(ctx.params.keyscale || "C major"),
          // 注意：这里**不能**因为有参考音频就关掉 audio codes。
          // 实机验证过 —— 关掉之后带参考的那条链路会直接输出静音（-67dB），
          // 而 ComfyUI 自带的 ACE 1.5 参考模板（BossaNova 换风格保旋律）也是全程开着。
          generate_audio_codes: ctx.params.generate_audio_codes !== false,

          cfg_scale: clamp(ctx.params.cfg_scale, 0, 100, 2),
          temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0 } },
        "8": { class_type: "EmptyAceStep1.5LatentAudio", inputs: { seconds, batch_size: 1 } },
      };
      let positive = ["5", 0];
      if (ref) {
        wf["3"] = { class_type: "LoadAudio", inputs: { audio: ref } };
        wf["4"] = { class_type: "VAEEncodeAudio", inputs: { audio: ["3", 0], vae: ["2", 0] } };
        wf["6"] = { class_type: "ReferenceTimbreAudio", inputs: { conditioning: ["5", 0], latent: ["4", 0] } };
        positive = ["6", 0];
      }
      wf["7"] = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } };
      wf["9"] = { class_type: "KSampler", inputs: {
        model: ["1", 0], seed: seed(ctx), steps: Math.round(clamp(ctx.params.steps, 1, 60, 8)),
        cfg: clamp(ctx.params.cfg, 0, 20, 1), sampler_name: "euler", scheduler: "simple",
        positive, negative: ["7", 0], latent_image: ["8", 0], denoise: 1 } };
      wf["10"] = { class_type: "VAEDecodeAudio", inputs: { samples: ["9", 0], vae: ["2", 0] } };
      wf["11"] = { class_type: "SaveAudioMP3", inputs: {
        audio: ["10", 0], filename_prefix: `${ctx.prefix}_resing`, quality: "320k" } };
      return wf;
    },
  },

  // ================================================ WF-30 人声 / 伴奏分离（Demucs）
  //
  // 翻唱的中间产物本身就很值钱：人声可以拿去做别的混音，伴奏可以拿去做口播 BGM。
  "WF-30": {
    id: "WF-30",
    label: "人声 / 伴奏分离（Demucs）",
    kind: "audio",
    engine: "demucs",
    mode: "split",
    fps: null,
    hasAudio: true,
    vramClass: "heavy",
    vramNeedMB: 12000,
    maxDurationS: 900,
    instances: [LOCAL_INSTANCE],
    machine: "本机 192.168.0.128",
    supports: { stemSplit: true, refAudios: 1 },
    defaults: {},
    build(ctx) {
      const song = songAudio(ctx);
      if (!song) throw Object.assign(new Error("分离需要 1 段音频（refs.audio）"), { code: "PARAM_INVALID" });
      return {
        "1": { class_type: "LoadAudio", inputs: { audio: song } },
        "2": { class_type: "AudioSeparation", inputs: {
          audio: ["1", 0], chunk_fade_shape: "half_sine", chunk_length: 16, chunk_overlap: 0.1 } },
        "3": { class_type: "AudioCombine", inputs: { audio_1: ["2", 0], audio_2: ["2", 1], method: "add" } },
        "4": { class_type: "AudioCombine", inputs: { audio_1: ["3", 0], audio_2: ["2", 2], method: "add" } },
        // 0 = 人声，1 = 伴奏（纯音乐）
        "5": { class_type: "SaveAudioMP3", inputs: { audio: ["2", 3], filename_prefix: `${ctx.prefix}_vocals`, quality: "320k" } },
        "6": { class_type: "SaveAudioMP3", inputs: { audio: ["4", 0], filename_prefix: `${ctx.prefix}_instrumental`, quality: "320k" } },
      };
    },
  },

  // ============================================ WF-36 训练新音色（RVC，录音/上传 → 可选的音色）
  //
  // 图：LoadAudio(干净人声) → RVCEngineNode(hubert/设备)
  //     → RVCDatasetPrepNode(切片 + HuBERT 特征 + F0) → RVCTrainingConfigNode(轮数等)
  //     → UnifiedModelTrainingNode(训练 → 导出 .pth + FAISS index)
  //
  // 训练产物直接落在 models/TTS/RVC/<名字>_<采样率>.pth，也就是「换成谁的声音」那个下拉框的目录，
  // 所以训练完不用重启 ComfyUI，刷新一下音色清单就能选（见 src/vocal.js 的 voices()）。
  //
  // 注意：这条链路不吃「歌曲」，吃的是**单人干净人声**（录音或上传），
  //      上游 src/vocal.js 会把多段样本先拼成一条再送进来。
  "WF-36": {
    id: "WF-36",
    label: "AI 翻唱 · 训练新音色（RVC）",
    kind: "audio",
    engine: "rvc_train",
    mode: "train",
    fps: null,
    hasAudio: false,
    vramClass: "heavy",
    vramNeedMB: 8000,
    maxDurationS: 3600,
    instances: [LOCAL_INSTANCE],
    machine: "本机 192.168.0.128",
    // 产物是 models/TTS/RVC 下的 .pth + .index，没有媒体文件可落盘：
    // 让任务层别把「没有输出文件」当成失败（见 jobs.js finalizeJob）。
    noOutputs: true,
    supports: { voiceTrain: true, refAudios: 1 },
    defaults: { epochs: 50, batch_size: 4, learning_rate: 0.0001, sample_rate: "48k" },
    build(ctx) {
      const sample = songAudio(ctx);
      if (!sample) throw Object.assign(new Error("训练音色需要 1 段人声样本（refs.audio）"), { code: "PARAM_INVALID" });
      const name = voiceNameOf(ctx.params.voice_name);
      const rateKey = trainRateOf(ctx.params.sample_rate);
      const epochs = Math.round(clamp(ctx.params.epochs, 10, 400, 50));
      const batchSize = Math.round(clamp(ctx.params.batch_size, 1, 16, 4));
      const saveEvery = clamp(ctx.params.save_every_epoch, 0, 50, Math.max(10, Math.round(epochs / 5)));
      return {
        "1": { class_type: "LoadAudio", inputs: { audio: sample } },
        // 训练只用到引擎里的 hubert / 设备这类共享设置，推理用的那几个滑块保持默认
        "2": { class_type: "RVCEngineNode", inputs: {
          pitch: 0, index_ratio: 0.75, consonant_protection: 0.25, volume_envelope: 0.25,
          hubert_model: "auto: Automatically select best available model",
          output_sample_rate: TRAIN_RATES[rateKey],
          enable_custom_chunking: false,
          device: "auto" } },
        "3": { class_type: "RVCDatasetPrepNode", inputs: {
          TTS_engine: ["2", 0],
          model_name: name,
          dataset_source: "",
          training_sample_rate: rateKey,
          cpu_workers: Math.round(clamp(ctx.params.cpu_workers, 1, 8, 4)),
          chunk_seconds: clamp(ctx.params.chunk_seconds, 1, 15, 3.0),
          overlap_seconds: clamp(ctx.params.overlap_seconds, 0, 2, 0.3),
          max_volume: clamp(ctx.params.max_volume, 0.1, 1, 0.95),
          mute_ratio: 0,
          // 同一批样本反复训练时吃缓存，改采样率/换样本才会重跑特征
          reuse_existing: ctx.params.reuse_existing !== false,
          opt_audio1: ["1", 0] } },
        "4": { class_type: "RVCTrainingConfigNode", inputs: {
          epochs,
          batch_size: batchSize,
          learning_rate: clamp(ctx.params.learning_rate, 0.000001, 0.01, 0.0001),
          gpu_ids: "",
          num_workers: 0,
          fp16_run: ctx.params.fp16_run !== false,
          save_every_epoch: Math.round(saveEvery),
          cache_data_in_gpu: ctx.params.cache_data_in_gpu !== false,
          max_checkpoints: 1,
          save_every_weights: false,
          train_index: true,
          save_best_model: true,
          log_every_epoch: 1,
          pretrained_generator: "auto",
          pretrained_discriminator: "auto" } },
        "5": { class_type: "UnifiedModelTrainingNode", inputs: {
          TTS_engine: ["2", 0],
          training_dataset: ["3", 0],
          training_config: ["4", 0],
          output_name: name,
          resume: false,
          overwrite: ctx.params.overwrite === true } },
        // ComfyUI 会拒收「没有任何输出节点」的图（HTTP 400 Prompt has no outputs），
        // 而训练节点本身不是输出节点 —— 拿它的 STRING 输出（产物摘要）挂一个 PreviewAny 交代结果。
        "6": { class_type: "PreviewAny", inputs: { source: ["5", 1] } },
      };
    },
  },
};

module.exports = { vocalWorkflows, LOCAL_INSTANCE, DEFAULT_VOICE, ACE_CKPT, ACE_VAE };