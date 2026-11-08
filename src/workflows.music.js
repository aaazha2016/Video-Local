"use strict";
/**
 * AI 创作音乐工作流（需求报告 附录 W）。
 *
 * 四条生成链路 + 一条本机后期链路，全部跑在**本机 192.168.0.128** 的 ComfyUI
 * （config.comfy.instances 里 id = "comfyui:local" 的那台）上，因为权重只在这台机器：
 *   · MiniMax Music 3：models/diffusion_models/minimax_music3_dit_fp16.safetensors
 *                       models/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors
 *                       models/vae/minimax_music3_dav.safetensors
 *   · YuE2：models/checkpoints/yue2_3b_int8_convrot.safetensors + models/audio_encoders/sheetsage2_bf16.safetensors
 *   · ACE-Step 1.5：models/checkpoints/ace_step_1.5_turbo_aio.safetensors + models/vae/scragvae_comfyui.safetensors
 *
 * YuE2 的图严格对齐 ComfyUI 自带模板《BossaNova_2_YuE2_锁旋律》：
 *   CheckpointLoaderSimple → YuE2GenerateMusic → KSampler → VAEDecodeAudio → 保存，
 *   **EmptyYuE2LatentAudio.seconds 必须接生成节点输出的 FLOAT（保持时长一致）**。
 * 锁旋律那一条再加 AudioEncoderLoader(SheetSage2) → SheetSage2AudioToABC → abc 输入。
 */

const { vocalWorkflows } = require("./workflows.vocal");

/** 本机 ComfyUI 实例 id（config.json 里 comfy.instances 的 id） */
const LOCAL_INSTANCE = "comfyui:local";

/** MiniMax Music 3：一体化权重（DiT + 文本编码器 + DAV 解码器） */
const MM3_DIT = "minimax_music3_dit_fp16.safetensors";
const MM3_TEXT = "minimax_music3_text_encoder_pruned_int8_convrot.safetensors";
const MM3_DAV = "minimax_music3_dav.safetensors";
/** YuE2：3B 一体化权重 + SheetSage2 旋律编码器 */
const YUE_CKPT = "yue2_3b_int8_convrot.safetensors";
const YUE_ENCODER = "sheetsage2_bf16.safetensors";
/** ACE-Step 1.5 */
const ACE_CKPT = "ace_step_1.5_turbo_aio.safetensors";
const ACE_VAE = "scragvae_comfyui.safetensors";

const seed = (ctx) => (Number.isFinite(ctx.params.seed) && ctx.params.seed >= 0
  ? Math.floor(ctx.params.seed)
  : Math.floor(Math.random() * 2 ** 40));

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** 歌词/风格描述：都从 params 里取，前端会把 AI 写好的结果回填进来 */
const lyricsOf = (ctx) => String(ctx.params.lyrics || "").trim();
const styleOf = (ctx, dflt) => String(ctx.params.style || ctx.params.tags || ctx.prompt || dflt).trim();

/** MiniMax Music 3 的 caption：官方节点推荐写成「全局信息 / 人声 / 编曲」三段式 */
function mm3Caption(ctx) {
  const raw = styleOf(ctx, "").trim();
  const instrumental = !lyricsOf(ctx);
  const body = raw || (instrumental
    ? "Global Metadata: Cinematic instrumental, 90 BPM, warm analog production.\n\nArrangement: Soft piano intro, strings build, gentle percussion."
    : "Global Metadata: Mandopop ballad, 90 BPM, warm analog production.\n\nVocal Details: Expressive lead vocal with soft harmonies.\n\nArrangement: Piano intro, strings in the chorus, gentle brush drums.");
  if (!instrumental) return body;
  // 纯音乐：显式告诉模型不要人声（否则它经常会自己加一段唱）
  if (/instrumental|no vocal|无人声/i.test(body)) return body;
  return `${body}\n\nVocal Details: Instrumental only, no vocals, no lyrics.`;
}

const musicWorkflows = {

  // ==================================================== WF-31 MiniMax Music 3 文生音乐
  // caption（一句话风格描述）+ 歌词 → 完整立体声歌曲；歌词留空就是纯音乐 / BGM。
  // 走官方一体化节点：一次把 AR 条件器 + flow DiT + DAV 解码器都加载好。
  "WF-31": {
    id: "WF-31",
    label: "AI 创作音乐 · 文生歌曲（MiniMax Music 3）",
    kind: "audio",
    engine: "minimax_music3",
    mode: "text2music",
    fps: null,
    hasAudio: true,
    vramClass: "heavy",
    vramNeedMB: 16000,
    maxDurationS: 360,
    instances: [LOCAL_INSTANCE],
    machine: "本机 192.168.0.128",
    supports: { text2music: true, instrumental: true },
    defaults: { seconds: 180, steps: 30, guidance_scale: 1.7, decode_mode: "auto" },
    build(ctx) {
      const seconds = clamp(ctx.params.seconds ?? ctx.params.duration_s, 10, 360, 180);
      return {
        "1": { class_type: "MiniMaxMusic3ModelsLoader", inputs: {
          transformer_name: MM3_DIT, text_encoder_name: MM3_TEXT, dav_name: MM3_DAV } },
        "2": { class_type: "MiniMaxMusic3AudioGenerate", inputs: {
          model: ["1", 0], clip: ["1", 1], vae: ["1", 2],
          caption: mm3Caption(ctx), lyrics: lyricsOf(ctx),
          max_duration: seconds, seed: seed(ctx),
          steps: Math.round(clamp(ctx.params.steps, 8, 60, 30)),
          guidance_scale: clamp(ctx.params.guidance_scale, 1, 3, 1.7),
          decode_mode: String(ctx.params.decode_mode || "auto"),
          ar_cfg_scale: clamp(ctx.params.ar_cfg_scale, 0, 5, 1.5),
          ar_top_k: Math.round(clamp(ctx.params.ar_top_k, 1, 200, 50)),
          tile_size: Math.round(clamp(ctx.params.tile_size, 256, 4096, 1536)),
          tile_overlap: Math.round(clamp(ctx.params.tile_overlap, 0, 512, 64)) } },
        "3": { class_type: "SaveAudioMP3", inputs: {
          audio: ["2", 0], filename_prefix: `${ctx.prefix}_music`, quality: "320k" } },
      };
    },
  },

  // ==================================================== WF-32 YuE2 文生歌曲
  // 中文歌词 → 整首歌（自带演唱）。风格用一段自然语言描述，可以写 BPM / 乐器 / 情绪。
  "WF-32": {
    id: "WF-32",
    label: "AI 创作音乐 · 歌词成曲（YuE2）",
    kind: "audio",
    engine: "yue2",
    mode: "text2song",
    fps: null,
    hasAudio: true,
    vramClass: "heavy",
    vramNeedMB: 12000,
    maxDurationS: 900,
    instances: [LOCAL_INSTANCE],
    machine: "本机 192.168.0.128",
    supports: { lyrics2song: true },
    defaults: { seconds: 180, steps: 32, temperature: 1.0, repetition_penalty: 1.2 },
    build(ctx) {
      const seconds = clamp(ctx.params.seconds ?? ctx.params.duration_s, 15, 900, 180);
      const lyrics = lyricsOf(ctx);
      if (!lyrics) throw Object.assign(new Error("歌词成曲需要先写歌词（手填，或点「AI 写词」）"), { code: "PARAM_INVALID" });
      return {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: YUE_CKPT } },
        "2": { class_type: "YuE2GenerateMusic", inputs: {
          clip: ["1", 1],
          style: styleOf(ctx, "mandopop, 90 BPM, warm analog, piano and strings, expressive vocal"),
          lyrics, abc: "",
          seed: seed(ctx), mode: String(ctx.params.mode || "full"),
          max_duration: seconds,
          temperature: clamp(ctx.params.temperature, 0, 5, 1.0),
          top_p: clamp(ctx.params.top_p, 0.01, 1, 0.95),
          top_k: Math.round(clamp(ctx.params.top_k, 1, 32768, 100)),
          repetition_penalty: clamp(ctx.params.repetition_penalty, 0.01, 10, 1.2) } },
        "3": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["2", 0] } },
        // 注意：这里的秒数必须跟生成节点输出的时长绑定，否则 KSampler 的 latent 会跟条件对不上
        "4": { class_type: "EmptyYuE2LatentAudio", inputs: { seconds: ["2", 1], batch_size: 1 } },
        "5": { class_type: "KSampler", inputs: {
          model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0],
          seed: seed(ctx), steps: Math.round(clamp(ctx.params.steps, 4, 100, 32)),
          cfg: clamp(ctx.params.cfg, 0, 20, 1), sampler_name: "dpm_2", scheduler: "sgm_uniform", denoise: 1 } },
        "6": { class_type: "VAEDecodeAudio", inputs: { samples: ["5", 0], vae: ["1", 2] } },
        "7": { class_type: "SaveAudioMP3", inputs: {
          audio: ["6", 0], filename_prefix: `${ctx.prefix}_song`, quality: "320k" } },
      };
    },
  },

  // ============================================ WF-33 YuE2 锁旋律改编（参考音乐 → 新歌）
  // 上传/选一段音乐 → SheetSage2 把旋律抽成 ABC 记谱 → 用同一段旋律配上新词、新编曲重新唱。
  // 也就是「保留原曲的旋律骨架，换风格、换歌词」的改编玩法。
  "WF-33": {
    id: "WF-33",
    label: "AI 创作音乐 · 锁旋律改编（YuE2 + SheetSage2）",
    kind: "audio",
    engine: "yue2_lock",
    mode: "melody_lock",
    fps: null,
    hasAudio: true,
    vramClass: "heavy",
    vramNeedMB: 12000,
    maxDurationS: 900,
    instances: [LOCAL_INSTANCE],
    machine: "本机 192.168.0.128",
    supports: { refAudios: 1, melodyLock: true },
    defaults: { seconds: 180, steps: 32 },
    build(ctx) {
      const ref = ctx.audios.audio || ctx.audios.voice || ctx.audios.speech || (ctx.audioList || [])[0] || null;
      if (!ref) throw Object.assign(new Error("锁旋律改编需要 1 段参考音乐（refs.audio）"), { code: "PARAM_INVALID" });
      const seconds = clamp(ctx.params.seconds ?? ctx.params.duration_s, 15, 900, 180);
      const lyrics = lyricsOf(ctx);
      if (!lyrics) throw Object.assign(new Error("锁旋律改编需要新歌词（手填，或点「AI 写词」）"), { code: "PARAM_INVALID" });
      return {
        "1": { class_type: "LoadAudio", inputs: { audio: ref } },
        "2": { class_type: "AudioEncoderLoader", inputs: { audio_encoder_name: YUE_ENCODER } },
        "3": { class_type: "SheetSage2AudioToABC", inputs: {
          audio_encoder: ["2", 0], audio: ["1", 0], mode: "melody" } },
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: YUE_CKPT } },
        "5": { class_type: "YuE2GenerateMusic", inputs: {
          clip: ["4", 1],
          style: styleOf(ctx, "acoustic pop, 90 BPM, fingerpicked guitar, soft strings, expressive vocal"),
          lyrics, abc: ["3", 0],
          seed: seed(ctx),
          // 旋律已经被 ABC 锁住，这里必须用 melody 模式（官方模板《BossaNova_2》同款写法）
          mode: "melody",
          max_duration: seconds,
          temperature: clamp(ctx.params.temperature, 0, 5, 1.0),
          top_p: clamp(ctx.params.top_p, 0.01, 1, 0.95),
          top_k: Math.round(clamp(ctx.params.top_k, 1, 32768, 100)),
          repetition_penalty: clamp(ctx.params.repetition_penalty, 0.01, 10, 1.2) } },
        "6": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
        "7": { class_type: "EmptyYuE2LatentAudio", inputs: { seconds: ["5", 1], batch_size: 1 } },
        "8": { class_type: "KSampler", inputs: {
          model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
          seed: seed(ctx), steps: Math.round(clamp(ctx.params.steps, 4, 100, 32)),
          cfg: clamp(ctx.params.cfg, 0, 20, 1), sampler_name: "dpm_2", scheduler: "sgm_uniform", denoise: 1 } },
        "9": { class_type: "VAEDecodeAudio", inputs: { samples: ["8", 0], vae: ["4", 2] } },
        "10": { class_type: "SaveAudioMP3", inputs: {
          audio: ["9", 0], filename_prefix: `${ctx.prefix}_lock`, quality: "320k" } },
      };
    },
  },

  // ============================================ WF-34 ACE-Step 1.5 文生音乐（复用重唱那条图）
  // 同一个模型既能「按歌词重唱」，也能「从零写一首」：区别只是给不给参考音频。
  // 这里直接复用 WF-29 的图，避免两处各写一遍导致漂移。
  "WF-34": {
    ...vocalWorkflows["WF-29"],
    id: "WF-34",
    label: "AI 创作音乐 · 文生歌曲（ACE-Step 1.5）",
    engine: "ace_step_1.5",
    mode: "text2music",
    defaults: { bpm: 96, seconds: 180, language: "zh", keyscale: "C major", timesignature: "4", steps: 8, cfg: 1 },
    build(ctx) {
      // 没给参考音频时就是纯文生音乐（use_reference 关掉，图里不会挂 LoadAudio 分支）
      const hasRef = !!(ctx.audios.audio || ctx.audios.voice || ctx.audios.speech || (ctx.audioList || [])[0]);
      const params = { ...ctx.params, use_reference: hasRef && ctx.params.use_reference !== false };
      return vocalWorkflows["WF-29"].build({ ...ctx, params });
    },
  },

  // ============================================ WF-35 音乐后期（本机 ffmpeg，不占显卡）
  // 裁剪 / 接长（循环到指定时长）/ 变速 / 响度归一 / 多段拼接 / 淡入淡出。
  // 与 WF-16L / WF-27 一样属于「本机处理」条目：不装配 ComfyUI 图，由 /api/music/edit 直接调 ffmpeg。
  "WF-35": {
    id: "WF-35",
    label: "音乐后期（裁剪 / 接长 / 变速 / 响度归一 · 本机处理）",
    kind: "audio",
    engine: "ffmpeg",
    mode: "edit",
    fps: null,
    hasAudio: true,
    vramClass: "light",
    maxDurationS: 3600,
    localOnly: true,
    instances: [LOCAL_INSTANCE],
    machine: "本机 192.168.0.128",
    supports: { trim: true, loop: true, speed: true, normalize: true, concat: true },
    defaults: {},
    build() {
      throw Object.assign(new Error("WF-35 由本机 ffmpeg 直接执行，请调用 /api/music/edit"), { code: "LOCAL_ONLY" });
    },
  },
};

module.exports = {
  musicWorkflows, LOCAL_INSTANCE,
  MM3_DIT, MM3_TEXT, MM3_DAV, YUE_CKPT, YUE_ENCODER, ACE_CKPT, ACE_VAE,
};