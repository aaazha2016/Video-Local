"use strict";
/**
 * 音频 / 成片合成工作流（需求报告 §8.15 WF-18、§8.14 WF-16、§12 导出规范）。
 *
 * 实机核查结论（报告 §15.2）：
 * - AceStep 系列权重（type="ace" 的 CLIP + checkpoint + VAE）与 MiniMax Music 3
 *   权重（minimax_music3_dit_fp16 等）**均不在盘**，因此"AI 生成 BGM"入口由
 *   能力自检自动置灰（built-in 工作流仍然保留，权重补齐后立即可用）。
 * - 可用的音频能力：上传 BGM 后与成片混轨、调音、裁剪、拼接（原生节点）。
 */

const { M } = require("./workflows.image");
const config = require("./config");

const seed = (ctx) => (Number.isFinite(ctx.params.seed) && ctx.params.seed >= 0
  ? Math.floor(ctx.params.seed)
  : Math.floor(Math.random() * 2 ** 40));

/**
 * 某段视频的真实帧率 / 时长（ctx.videoMeta 由 jobs.buildContext 现读现解析填充）。
 * 挂音轨时绝不能硬编码 24：Wan 系列出的是 16fps，MiniMax-H3 出的是 24fps，
 * 用错帧率会把成品变成快放或慢放。
 */
const videoFps = (ctx, i = 0) => {
  const f = Number(ctx.videoMeta?.[i]?.fps);
  return Number.isFinite(f) && f > 0 ? Math.round(f) : (config.export.targetFps || 24);
};
/** 取某段视频的元数据条目（videoMeta 由 jobs.buildContext 现读现解析填充） */
const videoMetaOf = (ctx, file) => (ctx.videoMeta || []).find((m) => m.file === file) || ctx.videoMeta?.[0] || null;

/**
 * 「把整段视频解码进内存」的安全闸门。
 *
 * GetVideoComponents 会把视频的**所有帧**一次性解码进内存，占用随
 * 「时长 × 分辨率 × 帧率」线性增长：实测 535.685 秒 / 720×1280 / 16fps =
 * 8569 帧 ≈ 95GB（光解码），算上混音与 CreateVideo 的副本峰值达 221GB，
 * 直接把 222 的 GPU1 打成 OOM（内核杀掉进程，任务白等一小时才超时）。
 * 所以超预算就当场报一句人话，而不是把整台机器拖垮。
 * 需要更长的视频 → 用「配音」页：那条链路走本机 ffmpeg，只复制视频流、不限时长。
 */
function assertDecodeBudget(meta, wfId) {
  const seconds = Number(meta?.durationMs) > 0 ? Number(meta.durationMs) / 1000 : null;
  if (!seconds) return;                                        // 拿不到时长就不拦，交给 ComfyUI
  const w = Number(meta?.width) || 720;
  const h = Number(meta?.height) || 1280;
  const fps = Number(meta?.fps) > 0 ? Number(meta.fps) : 24;
  const frames = Math.max(1, Math.round(seconds * fps));
  const decodedGB = (frames * w * h * 3 * 4) / 1073741824;     // RGB / fp32
  const budgetGB = Number(config.comfy.audioMuxMaxDecodeGB) || 40;
  if (decodedGB <= budgetGB) return;
  throw Object.assign(new Error(
    `${wfId} 需要把整段视频解码进内存：这段 ${seconds.toFixed(1)} 秒的视频解码后约 ` +
    `${Math.round(decodedGB)}GB、峰值约 ${Math.round(decodedGB * 2.4)}GB，超过安全预算 ${budgetGB}GB。` +
    "再跑下去会把 222 的 ComfyUI 打成 OOM（上次就是这样被内核杀掉、任务白等一小时）。" +
    "请先剪短，或改用「配音」页 —— 那条链路走本机 ffmpeg，只复制视频流、不限时长。"),
    { code: "VIDEO_TOO_LONG_FOR_COMFY" });
}

const videoSeconds = (ctx, i = 0) => {
  const ms = Number(ctx.videoMeta?.[i]?.durationMs);
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
};

const audioWorkflows = {

  // ============================== WF-18 AI 生成 BGM（MiniMax Music 3 · 本机）
  // 走官方一体化节点（MiniMaxMusic3ModelsLoader 一次加载 DiT + 文本编码器 + DAV 解码器），
  // 与 WF-31 同一套模型、同一个实例。旧版用的是 UNETLoader / CLIPLoader / VAELoader 分体加载，
  // 那三个节点的下拉里根本没有这两个权重，装配校验必然失败 —— 权重一直在盘上，是连线错了。
  "WF-18": {
    id: "WF-18",
    label: "AI 生成 BGM / 环境音（MiniMax Music 3）",
    kind: "audio",
    engine: "minimax_music3",
    mode: "t2m",
    fps: null,
    hasAudio: true,
    vramClass: "heavy",
    vramNeedMB: 16000,
    maxDurationS: 300,
    instances: ["comfyui:local"],
    machine: "本机 192.168.0.128",
    supports: { text2music: true, instrumental: true },
    defaults: { duration_s: 180, steps: 30, cfg: 1.7 },
    requiredModels: [
      { folder: "diffusion_models", name: "minimax_music3_dit_fp16.safetensors" },
      { folder: "text_encoders", name: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors" },
      { folder: "vae", name: "minimax_music3_dav.safetensors" },
    ],
    build(ctx) {
      const seconds = Math.min(360, Math.max(10, Number(ctx.params.duration_s ?? 20)));
      const lyrics = String(ctx.params.lyrics || "").trim();
      let caption = String(ctx.params.music_caption || ctx.prompt || "").trim()
        || "Global Metadata: Cinematic instrumental, 90 BPM, warm analog production.\n\nArrangement: Soft piano intro, strings build, gentle percussion.";
      // 纯音乐：显式声明不要人声，否则模型常常自己加一段唱
      if (!lyrics && !/instrumental|no vocal|无人声/i.test(caption)) {
        caption += "\n\nVocal Details: Instrumental only, no vocals, no lyrics.";
      }
      return {
        "1": { class_type: "MiniMaxMusic3ModelsLoader", inputs: {
          transformer_name: "minimax_music3_dit_fp16.safetensors",
          text_encoder_name: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
          dav_name: "minimax_music3_dav.safetensors" } },
        "2": { class_type: "MiniMaxMusic3AudioGenerate", inputs: {
          model: ["1", 0], clip: ["1", 1], vae: ["1", 2],
          caption, lyrics,
          max_duration: seconds, seed: seed(ctx),
          steps: Math.round(Math.min(60, Math.max(8, Number(ctx.params.steps ?? 30)))),
          guidance_scale: Math.min(3, Math.max(1, Number(ctx.params.cfg ?? ctx.params.guidance_scale ?? 1.7))),
          decode_mode: "auto", ar_cfg_scale: 1.5, ar_top_k: 50, tile_size: 1536, tile_overlap: 64 } },
        "3": { class_type: "SaveAudioMP3", inputs: {
          audio: ["2", 0], filename_prefix: `${ctx.prefix}_bgm`, quality: "320k" } },
      };
    },
  },

  // ==================== WF-18M BGM 混音（可用：上传 BGM → 与成片音轨混音/替换）
  "WF-18M": {
    id: "WF-18M",
    label: "成片混音 · BGM 与音轨合成（上传 BGM）",
    kind: "video",
    engine: "native",
    mode: "mix",
    fps: null,
    hasAudio: true,
    vramClass: "light",
    vramNeedMB: 8000,
    maxDurationS: 600,
    supports: { mixAudio: true, refVideos: 1, refAudios: 1 },
    defaults: { bgm_volume_db: -12, keep_original_audio: true },
    build(ctx) {
      const video = ctx.videos.source_video || ctx.videoList[0];
      const bgm = ctx.audios.bgm || ctx.audios.audio;
      if (!video) throw Object.assign(new Error("混音需要 1 段视频（refs.source_video）"), { code: "PARAM_INVALID" });
      if (!bgm) throw Object.assign(new Error("混音需要 1 段 BGM 音频（refs.bgm）"), { code: "PARAM_INVALID" });
      assertDecodeBudget(videoMetaOf(ctx, video), "WF-18M");
      const wf = {
        "1": { class_type: "LoadVideo", inputs: { file: video } },
        "2": { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } },
        "3": { class_type: "LoadAudio", inputs: { audio: bgm } },
        "4": { class_type: "AudioAdjustVolume", inputs: { audio: ["3", 0], volume: Number(ctx.params.bgm_volume_db ?? -12) } },
      };
      let audioRef = ["4", 0];
      if (ctx.params.keep_original_audio !== false) {
        wf["5"] = { class_type: "AudioConcat", inputs: { audio1: ["2", 1], audio2: ["4", 0], direction: "after" } };
        audioRef = ["5", 0];
      }
      wf["6"] = { class_type: "CreateVideo", inputs: { images: ["2", 0], fps: videoFps(ctx), audio: audioRef } };
      wf["7"] = { class_type: "SaveVideo", inputs: {
        video: ["6", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } };
      return wf;
    },
  },

  // ============================== WF-25 视频 + 音轨直出（把配音挂到已生成的画面上）
  "WF-25": {
    id: "WF-25",
    label: "音轨合成（配音 / 音频挂载到成片）",
    kind: "video",
    engine: "native",
    mode: "mux",
    fps: null,
    hasAudio: true,
    vramClass: "light",
    vramNeedMB: 8000,
    maxDurationS: 600,
    supports: { muxAudio: true, refVideos: 1, refAudios: 1 },
    defaults: { replace: true },
    build(ctx) {
      const video = ctx.videos.source_video || ctx.videoList[0];
      const audio = ctx.audios.voice || ctx.audios.audio || ctx.audioList[0];
      if (!video) throw Object.assign(new Error("音轨合成需要 1 段视频（refs.source_video）"), { code: "PARAM_INVALID" });
      if (!audio) throw Object.assign(new Error("音轨合成需要 1 段音频（refs.audio）"), { code: "PARAM_INVALID" });
      assertDecodeBudget(videoMetaOf(ctx, video), "WF-25");
      return {
        "1": { class_type: "LoadVideo", inputs: { file: video } },
        "2": { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } },
        "3": { class_type: "LoadAudio", inputs: { audio } },
        "4": { class_type: "AudioAdjustVolume", inputs: { audio: ["3", 0], volume: Number(ctx.params.volume_db ?? 0) } },
        "6": { class_type: "CreateVideo", inputs: { images: ["2", 0], fps: videoFps(ctx), audio: ["4", 0] } },
        "7": { class_type: "SaveVideo", inputs: {
          video: ["6", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } },
      };
    },
  },

  // ============ WF-25L 音轨合成（自己上传的音频 → 直接挂到画面上 · 本机处理）
  //
  // 与 WF-26 的分工：WF-26 是「自己写台词 → TTS 念出来 → 合轨」，音频是现场合成的；
  // 这条不经过语音合成 —— 视频和音频都是现成的（视频从素材库挑，音频**由用户本地上传**），
  // 只是把两轨并成一条。底层同样是 src/mux.js 那段 ffmpeg（复制视频流 + 重编码音轨），
  // 单独留一个工作流 id 是为了任务中心 / 能力自检里一眼能分清是哪一种活儿。
  "WF-25L": {
    id: "WF-25L",
    label: "音轨合成（本地上传音频 → 挂到视频，本机处理）",
    kind: "video",
    engine: "local",
    mode: "mux",
    fps: null,
    hasAudio: true,
    vramClass: "light",
    vramNeedMB: 0,
    maxDurationS: null,
    localOnly: true,
    localNote: "本机 ffmpeg 处理：视频流原样复制、只重编码音轨，不占 222 的 GPU，视频多长都能合",
    supports: { muxAudio: true, refVideos: 1, refAudios: 1 },
    defaults: { voice_volume_db: 0, original_volume_db: -14, keep_original: true },
    build() {
      throw Object.assign(new Error(
        "WF-25L 由本机 ffmpeg 直接执行（src/mux.js），不再装配 ComfyUI 图；请走 /api/mux"),
        { code: "LOCAL_ONLY" });
    },
  },

  // ============ WF-26 配音合成（用户自填文字 → 语音 → 挂到已生成/已上传的画面上）
  //
  // ⚠️ 这一条不再交给 ComfyUI，改成「本机处理」的占位条目（localOnly）。
  // 实测复盘（需求报告 附录 H.4）：原来的图是 GetVideoComponents → CreateVideo，前者会把
  // 整段视频的**所有帧**一次性解码进内存：8 分 55 秒的 720×1280 = 8569 帧 ≈ 95GB，
  // 再叠上 AudioMerge / CreateVideo 的副本，直接把 222 的 GPU1 实例吃到 221GB，
  // 被内核 OOM Killer 拍死；5 秒的短片却完全正常 —— 也就是「视频一长必挂」。
  // 现在改由 src/mux.js 在本机做：ffmpeg 复制视频流 + 只重编码音轨，不解画面、不碰 GPU，
  // 同一段 8 分 55 秒的视频 7 秒出片，显存留给真正需要它的生成任务。
  // 保留这个条目是为了：能力自检 / 工作流清单里看得到它，任务记录里也有可读的标识。
  // ============ WF-16L 本机拼接成片（ffmpeg concat）
  //
  // 能力与 WF-16（222 上的 ConcatenateVideo）相同，但跑在本机：
  //   · 成片不必再上传回 222 —— 那条路会先撞 ComfyUI 的单请求 100MB 上限（HTTP 413），
  //     十几段一起拼必然失败；就算不撞上限，几百兆来回传也是白等；
  //   · 拼接是纯 I/O，不吃显存，不该去挤 GPU 队列；
  //   · 顺序完全由用户在前端排的片段数组决定，规格不一致的片段自动对齐。
  // 实现见 src/concat.js，由 /api/export/final（默认引擎）调用。
  "WF-16L": {
    id: "WF-16L",
    label: "视频拼接 / 续长合片（本机执行 · 自选片段与顺序）",
    kind: "video",
    engine: "local",
    mode: "concat",
    fps: null,
    hasAudio: true,
    vramClass: "light",
    vramNeedMB: 0,
    maxDurationS: 3600,
    localOnly: true,
    localNote: "本机 ffmpeg 处理：规格一致的片段直接流拷贝，异形片段自动缩放补帧、缺音轨的补静音；不占 222 的显存",
    supports: { concat: true, refVideos: 100, hd: true },
    defaults: { hd: false, bgm_volume: 0.3 },
    build() {
      throw Object.assign(new Error(
        "WF-16L 由本机 ffmpeg 直接执行，请调用 /api/export/final（engine 留空或传 local）"),
        { code: "LOCAL_ONLY" });
    },
  },
  // ============ WF-27 字幕烧录（分镜台词 → 硬字幕，本机处理）
  //
  // 同上一条：这是纯像素活儿（ffmpeg 的 subtitles 滤镜 + libass），放本机跑，
  // 不占 222 的显存、也不用排队；顺便把 .srt 留在成片旁边，方便导入剪映做软字幕。
  // 实现见 src/subtitle.js，由 /api/export/final 的 subtitles 开关在拼接完成后自动接上。
  "WF-27": {
    id: "WF-27",
    label: "字幕烧录（分镜台词 → 硬字幕，本机处理）",
    kind: "video",
    engine: "local",
    mode: "subtitle",
    fps: null,
    hasAudio: true,
    vramClass: "light",
    vramNeedMB: 0,
    maxDurationS: 3600,
    localOnly: true,
    localNote: "本机处理：ffmpeg 把字幕烧进画面，不经过 ComfyUI、不占用 222 的显存",
    supports: { subtitle: true },
    defaults: {},
    build() { throw Object.assign(new Error("WF-27 由本机 ffmpeg 直接执行，请调用 /api/export/final 并传 subtitles=true"), { code: "LOCAL_ONLY" }); },
  },

  "WF-26": {
    id: "WF-26",
    label: "配音合成（自填文字 → 语音 → 视频，本机处理）",
    kind: "video",
    engine: "local",
    mode: "dub",
    fps: null,
    hasAudio: true,
    vramClass: "light",
    vramNeedMB: 0,
    maxDurationS: null,
    localOnly: true,
    localNote: "本机 ffmpeg 处理：视频流原样复制、只重编码音轨，不占 222 的 GPU，视频多长都能合",
    supports: { muxAudio: true, speech: true, dub: true, refVideos: 1, refAudios: 1 },
    defaults: { voice_volume_db: 0, original_volume_db: -14, keep_original: true },
    build() {
      throw Object.assign(new Error(
        "WF-26 已改为本机合成（src/mux.js），不再装配 ComfyUI 图；请走 /api/dub，或故事创作的「带声音」开关"),
        { code: "LOCAL_ONLY" });
    },
  },
  // ==================================== WF-23 帧插值（实机模型目录为空，能力自检置灰）
  "WF-23": {
    id: "WF-23",
    label: "视频提帧 / 帧插值",
    kind: "video",
    engine: "native",
    mode: "interpolate",
    fps: null,
    hasAudio: false,
    vramClass: "medium",
    vramNeedMB: 16000,
    maxDurationS: 120,
    supports: { interpolate: true },
    defaults: { multiplier: 2 },
    unavailableReason: "帧插值模型目录（frame_interpolation）为空，ComfyUI 的 FrameInterpolationModelLoader 无任何可选模型，请先放入 RIFE/FILM 等插值权重。",
    build(ctx) {
      const video = ctx.videos.source_video || ctx.videoList[0];
      if (!video) throw Object.assign(new Error("帧插值需要 1 段视频（refs.source_video）"), { code: "PARAM_INVALID" });
      return {
        "1": { class_type: "LoadVideo", inputs: { file: video } },
        "2": { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } },
        "3": { class_type: "FrameInterpolationModelLoader", inputs: { model_name: ctx.params.model_name || "" } },
        "4": { class_type: "FrameInterpolate", inputs: { interp_model: ["3", 0], images: ["2", 0], multiplier: ctx.params.multiplier ?? 2 } },
        "5": { class_type: "CreateVideo", inputs: { images: ["4", 0], fps: ctx.params.target_fps ?? 48 } },
        "6": { class_type: "SaveVideo", inputs: {
          video: ["5", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } },
      };
    },
  },
};

module.exports = { audioWorkflows };
