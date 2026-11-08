"use strict";
/**
 * 视频 / 音频相关 ComfyUI 工作流注册表。
 * 对应需求报告：§3 能力矩阵、§7.3 参数注入、§7.5 对齐规则、§8.7 ~ §8.15。
 *
 * 说明：
 * - 每个 WF 都是 builder(ctx) -> ComfyUI API Format JSON（键为节点 id 字符串）。
 * - 权重文件名与需求报告 §2 的实机清单一字不差；如与实机 COMBO 不一致会由
 *   capabilities 自检（workflows.registry.js）标记为 unavailable，前端置灰。
 * - ctx 契约见 src/jobs.js 的 buildContext()。
 */

const { M, alignUp, clamp, wanFrames, minimaxFrames, ltxFrames, BASE_NEGATIVE } = require("./workflows.image");

const seed = (ctx) => (Number.isFinite(ctx.params.seed) && ctx.params.seed >= 0
  ? Math.floor(ctx.params.seed)
  : Math.floor(Math.random() * 2 ** 40));

const negative = (ctx) => [BASE_NEGATIVE, ctx.params.negative_prompt || "", ctx.style?.negative || ""]
  .filter(Boolean).join(", ");

/** 运镜 → WanCameraEmbedding.camera_pose 枚举（报告 §8.10，共 9 种） */
const CAMERA_POSES = {
  static: "Static", still: "Static",
  pan_up: "Pan Up", up: "Pan Up",
  pan_down: "Pan Down", down: "Pan Down",
  pan_left: "Pan Left", left: "Pan Left",
  pan_right: "Pan Right", right: "Pan Right",
  zoom_in: "Zoom In", push: "Zoom In",
  zoom_out: "Zoom Out", pull: "Zoom Out",
  orbit: "ClockWise (CW)", acw: "Anti Clockwise (ACW)", cw: "ClockWise (CW)",
};
const cameraPose = (v) => CAMERA_POSES[String(v || "static").toLowerCase()] || CAMERA_POSES.static;

/** 供上层校验/前端展示的长度换算 */
const frames = {
  wan: (d, fps = 16) => wanFrames(d, fps),
  minimax: (d, fps = 24) => minimaxFrames(d, fps),
  ltx: (d, fps = 24) => ltxFrames(d, fps),
};

function need(ctx, key, msg) {
  const v = ctx.images?.[key] || ctx.videos?.[key] || ctx.audios?.[key];
  if (!v) throw Object.assign(new Error(msg || `缺少必需素材：${key}`), { code: "PARAM_INVALID" });
  return v;
}

function firstImage(ctx) {
  return ctx.images?.start_image || ctx.images?.character || ctx.imageList?.[0] || null;
}

// ---------------------------------------------------------------- 视频工作流
/**
 * 选拼接的目标尺寸：取出现次数最多的那一种（多数票），
 * 票数相同则取面积更大的。全部未知时返回 null，由调用方兜底。
 */
function pickTargetSize(sizes) {
  const tally = new Map();
  for (const s of sizes) {
    if (!s || !s.width || !s.height) continue;
    const key = `${s.width}x${s.height}`;
    const cur = tally.get(key) || { width: s.width, height: s.height, count: 0 };
    cur.count += 1;
    tally.set(key, cur);
  }
  let best = null;
  for (const v of tally.values()) {
    if (!best || v.count > best.count || (v.count === best.count && v.width * v.height > best.width * best.height)) best = v;
  }
  return best ? { width: best.width, height: best.height } : null;
}

/**
 * 选拼接的目标帧率：同样取多数票。
 * 另外要做一次保险：本机没有插帧模型（WF-23 缺 FrameInterpolation 权重），
 * 只能「抽帧降帧率」，不能「补帧升帧率」，所以一旦有片段的帧率低于主流帧率，
 * 就退到最低帧率——这样每个异形片段都是降帧率，都能被正确处理。
 */
function pickTargetFps(infos) {
  const known = infos.filter((s) => s && s.fps);
  if (!known.length) return null;
  const tally = new Map();
  for (const s of known) {
    const key = Math.round(s.fps * 1000) / 1000;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [fps, n] of tally) {
    if (n > bestN || (n === bestN && fps < best)) { best = fps; bestN = n; }
  }
  const lowest = Math.min(...known.map((s) => s.fps));
  return known.some((s) => s.fps < best - 0.05) ? Math.round(lowest * 1000) / 1000 : best;
}

const videoWorkflows = {

  // ============================================================ WF-07 图生视频
  "WF-07": {
    id: "WF-07",
    label: "图生视频 · 图片动起来（Wan 2.2 I2V 14B / 4 步加速）",
    kind: "video",
    engine: "wan22",
    mode: "i2v",
    fps: 16,
    hasAudio: false,
    vramClass: "heavy",
    vramNeedMB: 40000,
    maxDurationS: 20,
    supports: { text2image: false, image2video: true, refImages: 1, refVideos: 0, refAudios: 0, camera: false, firstLastFrame: false, contextWindow: true },
    defaults: { duration_s: 5, steps: 4, cfg: 1.0 },
    frames: (d) => wanFrames(d, 16),
    build(ctx) {
      const img = firstImage(ctx);
      if (!img) throw Object.assign(new Error("图生视频需要 1 张起始图（refs.start_image）"), { code: "PARAM_INVALID" });
      const length = wanFrames(ctx.params.duration_s ?? 5, 16);
      const long = length > 81;
      const shift = Number(ctx.params.shift ?? 5.0);
      const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.wanI2vHigh, weight_dtype: "default" } },
        "2": { class_type: "UNETLoader", inputs: { unet_name: M.wanI2vLow, weight_dtype: "default" } },
        "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: M.loraI2vHigh, strength_model: 1.0 } },
        "4": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: M.loraI2vLow, strength_model: 1.0 } },
        "5": { class_type: "ModelSamplingSD3", inputs: { model: ["3", 0], shift } },
        "6": { class_type: "ModelSamplingSD3", inputs: { model: ["4", 0], shift } },
        "7": { class_type: "CLIPLoader", inputs: { clip_name: M.wanClip, type: "wan", device: "default" } },
        "8": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: ctx.prompt } },
        "9": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: negative(ctx) } },
        "10": { class_type: "VAELoader", inputs: { vae_name: M.wanVae } },
        "11": { class_type: "LoadImage", inputs: { image: img } },
        "12": { class_type: "WanImageToVideo", inputs: {
          positive: ["8", 0], negative: ["9", 0], vae: ["10", 0],
          width: ctx.width, height: ctx.height, length,
          batch_size: ctx.batchSize, start_image: ["11", 0] } },
      };
      let highRef = ["5", 0];
      let lowRef = ["6", 0];
      if (long) {
        wf["20"] = { class_type: "WanContextWindowsManual", inputs: {
          model: highRef, context_length: 81, context_overlap: 30, context_schedule: "standard_uniform",
          context_stride: 1, closed_loop: false, fuse_method: "pyramid", freenoise: true, retain_first_frame: false,
          // 该输入虽在 /object_info 里带 default，但走 API 提交时 ComfyUI 仍判为必填，必须显式给出
          split_conds_to_windows: false } };
        wf["21"] = { class_type: "WanContextWindowsManual", inputs: {
          model: lowRef, context_length: 81, context_overlap: 30, context_schedule: "standard_uniform",
          context_stride: 1, closed_loop: false, fuse_method: "pyramid", freenoise: true, retain_first_frame: false,
          split_conds_to_windows: false } };
        highRef = ["20", 0];
        lowRef = ["21", 0];
      }
      wf["13"] = { class_type: "KSamplerAdvanced", inputs: {
        model: highRef, add_noise: "enable", noise_seed: seed(ctx),
        steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
        positive: ["12", 0], negative: ["12", 1], latent_image: ["12", 2],
        start_at_step: 0, end_at_step: 2, return_with_leftover_noise: "enable" } };
      wf["14"] = { class_type: "KSamplerAdvanced", inputs: {
        model: lowRef, add_noise: "disable", noise_seed: seed(ctx),
        steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
        positive: ["12", 0], negative: ["12", 1], latent_image: ["13", 0],
        start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: "disable" } };
      wf["15"] = { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["10", 0] } };
      wf["16"] = { class_type: "CreateVideo", inputs: { images: ["15", 0], fps: 16 } };
      wf["17"] = { class_type: "SaveVideo", inputs: {
        video: ["16", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } };
      return wf;
    },
  },

  // ============================================================ WF-07T 文生视频
  "WF-07T": {
    id: "WF-07T",
    label: "文生视频（Wan 2.2 T2V 14B / 4 步加速）",
    kind: "video",
    engine: "wan22",
    mode: "t2v",
    fps: 16,
    hasAudio: false,
    vramClass: "heavy",
    vramNeedMB: 40000,
    maxDurationS: 20,
    supports: { text2video: true, refImages: 0, refVideos: 0, refAudios: 0, contextWindow: true },
    defaults: { duration_s: 5, steps: 4, cfg: 1.0 },
    frames: (d) => wanFrames(d, 16),
    build(ctx) {
      const length = wanFrames(ctx.params.duration_s ?? 5, 16);
      const long = length > 81;
      const shift = Number(ctx.params.shift ?? 5.0);
      const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.wanT2vHigh, weight_dtype: "default" } },
        "2": { class_type: "UNETLoader", inputs: { unet_name: M.wanT2vLow, weight_dtype: "default" } },
        "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: M.loraT2vHigh, strength_model: 1.0 } },
        "4": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: M.loraT2vLow, strength_model: 1.0 } },
        "5": { class_type: "ModelSamplingSD3", inputs: { model: ["3", 0], shift } },
        "6": { class_type: "ModelSamplingSD3", inputs: { model: ["4", 0], shift } },
        "7": { class_type: "CLIPLoader", inputs: { clip_name: M.wanClip, type: "wan", device: "default" } },
        "8": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: ctx.prompt } },
        "9": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: negative(ctx) } },
        "10": { class_type: "VAELoader", inputs: { vae_name: M.wanVae } },
        "12": { class_type: "Wan22ImageToVideoLatent", inputs: {
          vae: ["10", 0], width: ctx.width, height: ctx.height, length, batch_size: ctx.batchSize } },
      };
      let highRef = ["5", 0];
      let lowRef = ["6", 0];
      if (long) {
        wf["20"] = { class_type: "WanContextWindowsManual", inputs: {
          model: highRef, context_length: 81, context_overlap: 30, context_schedule: "standard_uniform",
          context_stride: 1, closed_loop: false, fuse_method: "pyramid", freenoise: true, retain_first_frame: false,
          // 该输入虽在 /object_info 里带 default，但走 API 提交时 ComfyUI 仍判为必填，必须显式给出
          split_conds_to_windows: false } };
        wf["21"] = { class_type: "WanContextWindowsManual", inputs: {
          model: lowRef, context_length: 81, context_overlap: 30, context_schedule: "standard_uniform",
          context_stride: 1, closed_loop: false, fuse_method: "pyramid", freenoise: true, retain_first_frame: false,
          split_conds_to_windows: false } };
        highRef = ["20", 0];
        lowRef = ["21", 0];
      }
      wf["13"] = { class_type: "KSamplerAdvanced", inputs: {
        model: highRef, add_noise: "enable", noise_seed: seed(ctx),
        steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
        positive: ["8", 0], negative: ["9", 0], latent_image: ["12", 0],
        start_at_step: 0, end_at_step: 2, return_with_leftover_noise: "enable" } };
      wf["14"] = { class_type: "KSamplerAdvanced", inputs: {
        model: lowRef, add_noise: "disable", noise_seed: seed(ctx),
        steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
        positive: ["8", 0], negative: ["9", 0], latent_image: ["13", 0],
        start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: "disable" } };
      wf["15"] = { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["10", 0] } };
      wf["16"] = { class_type: "CreateVideo", inputs: { images: ["15", 0], fps: 16 } };
      wf["17"] = { class_type: "SaveVideo", inputs: {
        video: ["16", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } };
      return wf;
    },
  },

  // ==================================================== WF-08 人物微动 / 动作迁移
  "WF-08": {
    id: "WF-08",
    label: "人物微动 / 动作迁移（Wan 2.2 Animate）",
    kind: "video",
    engine: "wan22_animate",
    mode: "animate",
    fps: 16,
    hasAudio: false,
    vramClass: "heavy",
    vramNeedMB: 34000,
    maxDurationS: 20,
    supports: { reference: true, poseVideo: true, refImages: 1, refVideos: 1, refAudios: 0 },
    defaults: { duration_s: 5, steps: 6, cfg: 1.0, pose_strength: 1.0, reference_image_strength: 1.0 },
    frames: (d) => wanFrames(d, 16),
    build(ctx) {
      const character = ctx.images.character || firstImage(ctx);
      if (!character) throw Object.assign(new Error("人物微动需要 1 张角色图（refs.character）"), { code: "PARAM_INVALID" });
      const drive = ctx.videos.pose_video || ctx.videos.control_video || null;
      const length = wanFrames(ctx.params.duration_s ?? 5, 16);
      const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.wanAnimate, weight_dtype: "default" } },
        "3": { class_type: "CLIPLoader", inputs: { clip_name: M.wanClip, type: "wan", device: "default" } },
        "4": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: ctx.prompt } },
        "5": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: negative(ctx) } },
        "6": { class_type: "VAELoader", inputs: { vae_name: M.wanVae } },
        "7": { class_type: "LoadImage", inputs: { image: character } },
      };
      let modelRef = ["1", 0];
      if (ctx.params.relight_lora !== false) {
        wf["2"] = { class_type: "LoraLoaderModelOnly", inputs: {
          model: ["1", 0], lora_name: M.wanAnimateLight, strength_model: ctx.params.relight_strength ?? 0.6 } };
        modelRef = ["2", 0];
      }
      if (drive) {
        wf["8"] = { class_type: "LoadVideo", inputs: { file: drive } };
        wf["9"] = { class_type: "GetVideoComponents", inputs: { video: ["8", 0] } };
        wf["10"] = { class_type: "WanAnimate2ToVideo", inputs: {
          positive: ["4", 0], negative: ["5", 0], vae: ["6", 0],
          width: ctx.width, height: ctx.height, length, batch_size: ctx.batchSize,
          video_frame_offset: 0,
          pose_strength: ctx.params.pose_strength ?? 1.0,
          pose_start_percent: ctx.params.pose_start_percent ?? 0.0,
          pose_end_percent: ctx.params.pose_end_percent ?? 1.0,
          reference_image_strength: ctx.params.reference_image_strength ?? 1.0,
          reference_image: ["7", 0], pose_video: ["9", 0] } };
      } else {
        wf["10"] = { class_type: "WanAnimateToVideo", inputs: {
          positive: ["4", 0], negative: ["5", 0], vae: ["6", 0],
          width: ctx.width, height: ctx.height, length: 77, batch_size: ctx.batchSize,
          continue_motion_max_frames: 5, video_frame_offset: 0,
          reference_image: ["7", 0] } };
      }
      wf["11"] = { class_type: "KSampler", inputs: {
        model: modelRef, seed: seed(ctx), steps: ctx.params.steps ?? 6, cfg: ctx.params.cfg ?? 1.0,
        sampler_name: "euler", scheduler: "simple",
        positive: ["10", 0], negative: ["10", 1], latent_image: ["10", 2], denoise: 1.0 } };
      wf["12"] = { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["6", 0] } };
      wf["13"] = { class_type: "CreateVideo", inputs: { images: ["12", 0], fps: 16 } };
      wf["14"] = { class_type: "SaveVideo", inputs: {
        video: ["13", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } };
      return wf;
    },
  },

  // ================================================== WF-09 口型驱动 / 数字人口播
  "WF-09": {
    id: "WF-09",
    label: "口型驱动 · 数字人口播（Wan 2.2 S2V）",
    kind: "video",
    engine: "wan22_s2v",
    mode: "s2v",
    fps: 16,
    hasAudio: true,
    vramClass: "heavy",
    vramNeedMB: 38000,
    maxDurationS: 20,
    supports: { image2video: true, speech: true, audioDriven: true, refImages: 1, refAudios: 1 },
    defaults: { duration_s: 5, steps: 20, cfg: 6.0 },
    frames: (d) => wanFrames(d, 16),
    build(ctx) {
      const portrait = ctx.images.character || firstImage(ctx);
      const audio = ctx.audios.speech || ctx.audios.audio;
      if (!portrait) throw Object.assign(new Error("口播视频需要 1 张人物图（refs.character）"), { code: "PARAM_INVALID" });
      if (!audio) throw Object.assign(new Error("口播视频需要 1 段配音音频（refs.audio）"), { code: "PARAM_INVALID" });
      const length = wanFrames(ctx.params.duration_s ?? 5, 16);
      return {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.wanS2v, weight_dtype: "default" } },
        "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: M.loraT2vHigh, strength_model: ctx.params.lora_strength ?? 0.6 } },
        "3": { class_type: "ModelSamplingSD3", inputs: { model: ["2", 0], shift: Number(ctx.params.shift ?? 8.0) } },
        "4": { class_type: "CLIPLoader", inputs: { clip_name: M.wanClip, type: "wan", device: "default" } },
        "5": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 0], text: ctx.prompt } },
        "6": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 0], text: negative(ctx) } },
        "7": { class_type: "VAELoader", inputs: { vae_name: M.wanVae } },
        "8": { class_type: "LoadImage", inputs: { image: portrait } },
        "9": { class_type: "LoadAudio", inputs: { audio } },
        "10": { class_type: "AudioEncoderLoader", inputs: { audio_encoder_name: M.wav2vec } },
        "11": { class_type: "AudioEncoderEncode", inputs: { audio_encoder: ["10", 0], audio: ["9", 0] } },
        "12": { class_type: "WanSoundImageToVideo", inputs: {
          positive: ["5", 0], negative: ["6", 0], vae: ["7", 0],
          width: ctx.width, height: ctx.height, length, batch_size: ctx.batchSize,
          audio_encoder_output: ["11", 0], ref_image: ["8", 0] } },
        "13": { class_type: "KSampler", inputs: {
          model: ["3", 0], seed: seed(ctx), steps: ctx.params.steps ?? 20, cfg: ctx.params.cfg ?? 6.0,
          sampler_name: "uni_pc", scheduler: "simple",
          positive: ["12", 0], negative: ["12", 1], latent_image: ["12", 2], denoise: 1.0 } },
        "14": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["7", 0] } },
        "15": { class_type: "CreateVideo", inputs: { images: ["14", 0], fps: 16, audio: ["9", 0] } },
        "16": { class_type: "SaveVideo", inputs: {
          video: ["15", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } },
      };
    },
  },

  // ====================================================== WF-10 运镜控制（推拉摇移）
  "WF-10": {
    id: "WF-10",
    label: "运镜控制 · 推拉摇移（Wan 2.2 Fun Camera）",
    kind: "video",
    engine: "wan22_camera",
    mode: "camera",
    fps: 16,
    hasAudio: false,
    vramClass: "heavy",
    vramNeedMB: 40000,
    maxDurationS: 20,
    supports: { image2video: true, camera: true, refImages: 1 },
    defaults: { duration_s: 5, camera_pose: "Zoom In", camera_speed: 1.0 },
    cameraPoses: Object.values(CAMERA_POSES),
    frames: (d) => wanFrames(d, 16),
    build(ctx) {
      const img = firstImage(ctx);
      if (!img) throw Object.assign(new Error("运镜视频需要 1 张起始图（refs.start_image）"), { code: "PARAM_INVALID" });
      const length = wanFrames(ctx.params.duration_s ?? 5, 16);
      const shift = Number(ctx.params.shift ?? 5.0);
      return {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.wanCameraHigh, weight_dtype: "default" } },
        "2": { class_type: "UNETLoader", inputs: { unet_name: M.wanCameraLow, weight_dtype: "default" } },
        "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: M.loraI2vHigh, strength_model: 1.0 } },
        "4": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: M.loraI2vLow, strength_model: 1.0 } },
        "5": { class_type: "ModelSamplingSD3", inputs: { model: ["3", 0], shift } },
        "6": { class_type: "ModelSamplingSD3", inputs: { model: ["4", 0], shift } },
        "7": { class_type: "CLIPLoader", inputs: { clip_name: M.wanClip, type: "wan", device: "default" } },
        "8": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: ctx.prompt } },
        "9": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: negative(ctx) } },
        "10": { class_type: "VAELoader", inputs: { vae_name: M.wanVae } },
        "11": { class_type: "LoadImage", inputs: { image: img } },
        "12": { class_type: "WanCameraEmbedding", inputs: {
          camera_pose: cameraPose(ctx.params.camera_pose || ctx.camera?.pose),
          width: ctx.width, height: ctx.height, length,
          speed: ctx.params.camera_speed ?? 1.0 } },
        "13": { class_type: "WanCameraImageToVideo", inputs: {
          positive: ["8", 0], negative: ["9", 0], vae: ["10", 0],
          width: ctx.width, height: ctx.height, length, batch_size: ctx.batchSize,
          start_image: ["11", 0], camera_conditions: ["12", 0] } },
        "14": { class_type: "KSamplerAdvanced", inputs: {
          model: ["5", 0], add_noise: "enable", noise_seed: seed(ctx),
          steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
          positive: ["13", 0], negative: ["13", 1], latent_image: ["13", 2],
          start_at_step: 0, end_at_step: 2, return_with_leftover_noise: "enable" } },
        "15": { class_type: "KSamplerAdvanced", inputs: {
          model: ["6", 0], add_noise: "disable", noise_seed: seed(ctx),
          steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
          positive: ["13", 0], negative: ["13", 1], latent_image: ["14", 0],
          start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: "disable" } },
        "16": { class_type: "VAEDecode", inputs: { samples: ["15", 0], vae: ["10", 0] } },
        "17": { class_type: "CreateVideo", inputs: { images: ["16", 0], fps: 16 } },
        "18": { class_type: "SaveVideo", inputs: {
          video: ["17", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } },
      };
    },
  },

  // ============================================================ WF-11 首尾帧控制
  "WF-11": {
    id: "WF-11",
    label: "首尾帧控制（Wan 2.2 FLF2V）",
    kind: "video",
    engine: "wan22",
    mode: "flf2v",
    fps: 16,
    hasAudio: false,
    vramClass: "heavy",
    vramNeedMB: 40000,
    maxDurationS: 20,
    supports: { image2video: true, firstLastFrame: true, refImages: 2 },
    defaults: { duration_s: 5, steps: 4, cfg: 1.0 },
    frames: (d) => wanFrames(d, 16),
    build(ctx) {
      const start = ctx.images.start_image || firstImage(ctx);
      const end = ctx.images.end_image;
      if (!start || !end) throw Object.assign(new Error("首尾帧控制需要 start_image 与 end_image 两张图"), { code: "PARAM_INVALID" });
      const length = wanFrames(ctx.params.duration_s ?? 5, 16);
      const shift = Number(ctx.params.shift ?? 5.0);
      return {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.wanI2vHigh, weight_dtype: "default" } },
        "2": { class_type: "UNETLoader", inputs: { unet_name: M.wanI2vLow, weight_dtype: "default" } },
        "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: M.loraI2vHigh, strength_model: 1.0 } },
        "4": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: M.loraI2vLow, strength_model: 1.0 } },
        "5": { class_type: "ModelSamplingSD3", inputs: { model: ["3", 0], shift } },
        "6": { class_type: "ModelSamplingSD3", inputs: { model: ["4", 0], shift } },
        "7": { class_type: "CLIPLoader", inputs: { clip_name: M.wanClip, type: "wan", device: "default" } },
        "8": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: ctx.prompt } },
        "9": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: negative(ctx) } },
        "10": { class_type: "VAELoader", inputs: { vae_name: M.wanVae } },
        "11": { class_type: "LoadImage", inputs: { image: start } },
        "18": { class_type: "LoadImage", inputs: { image: end } },
        "12": { class_type: "WanFirstLastFrameToVideo", inputs: {
          positive: ["8", 0], negative: ["9", 0], vae: ["10", 0],
          width: ctx.width, height: ctx.height, length, batch_size: ctx.batchSize,
          start_image: ["11", 0], end_image: ["18", 0] } },
        "13": { class_type: "KSamplerAdvanced", inputs: {
          model: ["5", 0], add_noise: "enable", noise_seed: seed(ctx),
          steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
          positive: ["12", 0], negative: ["12", 1], latent_image: ["12", 2],
          start_at_step: 0, end_at_step: 2, return_with_leftover_noise: "enable" } },
        "14": { class_type: "KSamplerAdvanced", inputs: {
          model: ["6", 0], add_noise: "disable", noise_seed: seed(ctx),
          steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
          positive: ["12", 0], negative: ["12", 1], latent_image: ["13", 0],
          start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: "disable" } },
        "15": { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["10", 0] } },
        "16": { class_type: "CreateVideo", inputs: { images: ["15", 0], fps: 16 } },
        "17": { class_type: "SaveVideo", inputs: {
          video: ["16", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } },
      };
    },
  },

  // ============================================ WF-12 参考视频驱动（VACE ref2v）
  "WF-12": {
    id: "WF-12",
    label: "参考视频驱动（Wan VACE ref2v）",
    kind: "video",
    engine: "wan22_vace",
    mode: "ref2v",
    fps: 16,
    hasAudio: false,
    vramClass: "heavy",
    vramNeedMB: 40000,
    maxDurationS: 20,
    supports: { reference: true, refImages: 1, refVideos: 1, driveByVideo: true },
    defaults: { duration_s: 5, steps: 4, cfg: 1.0, strength: 1.0 },
    frames: (d) => wanFrames(d, 16),
    build(ctx) {
      const character = ctx.images.character || ctx.images.start_image || firstImage(ctx);
      const control = ctx.videos.control_video || ctx.videos.pose_video;
      if (!character) throw Object.assign(new Error("参考生视频需要 1 张角色参考图（refs.character）"), { code: "PARAM_INVALID" });
      if (!control) throw Object.assign(new Error("参考生视频需要 1 段驱动视频（refs.control_video）"), { code: "PARAM_INVALID" });
      const length = wanFrames(ctx.params.duration_s ?? 5, 16);
      const shift = Number(ctx.params.shift ?? 5.0);
      return {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.wanVaceHigh, weight_dtype: "default" } },
        "2": { class_type: "UNETLoader", inputs: { unet_name: M.wanVaceLow, weight_dtype: "default" } },
        "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: M.loraI2vHigh, strength_model: 1.0 } },
        "4": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: M.loraI2vLow, strength_model: 1.0 } },
        "5": { class_type: "ModelSamplingSD3", inputs: { model: ["3", 0], shift } },
        "6": { class_type: "ModelSamplingSD3", inputs: { model: ["4", 0], shift } },
        "7": { class_type: "CLIPLoader", inputs: { clip_name: M.wanClip, type: "wan", device: "default" } },
        "8": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: ctx.prompt } },
        "9": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: negative(ctx) } },
        "10": { class_type: "VAELoader", inputs: { vae_name: M.wanVae } },
        "11": { class_type: "LoadImage", inputs: { image: character } },
        "12": { class_type: "LoadVideo", inputs: { file: control } },
        "13": { class_type: "GetVideoComponents", inputs: { video: ["12", 0] } },
        "14": { class_type: "WanVaceToVideo", inputs: {
          positive: ["8", 0], negative: ["9", 0], vae: ["10", 0],
          width: ctx.width, height: ctx.height, length, batch_size: ctx.batchSize,
          strength: ctx.params.strength ?? 1.0,
          control_video: ["13", 0], reference_image: ["11", 0] } },
        "15": { class_type: "KSamplerAdvanced", inputs: {
          model: ["5", 0], add_noise: "enable", noise_seed: seed(ctx),
          steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
          positive: ["14", 0], negative: ["14", 1], latent_image: ["14", 2],
          start_at_step: 0, end_at_step: 2, return_with_leftover_noise: "enable" } },
        "16": { class_type: "KSamplerAdvanced", inputs: {
          model: ["6", 0], add_noise: "disable", noise_seed: seed(ctx),
          steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
          positive: ["14", 0], negative: ["14", 1], latent_image: ["15", 0],
          start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: "disable" } },
        "17": { class_type: "VAEDecode", inputs: { samples: ["16", 0], vae: ["10", 0] } },
        "18": { class_type: "CreateVideo", inputs: { images: ["17", 0], fps: 16 } },
        "19": { class_type: "SaveVideo", inputs: {
          video: ["18", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } },
      };
    },
  },

  // ================================== WF-13 视频指令编辑（VACE v2v，改天气/换装/换物）
  "WF-13": {
    id: "WF-13",
    label: "视频指令编辑（Wan VACE v2v）",
    kind: "video",
    engine: "wan22_vace",
    mode: "v2v",
    fps: 16,
    hasAudio: false,
    vramClass: "heavy",
    vramNeedMB: 40000,
    maxDurationS: 20,
    supports: { video2video: true, refVideos: 1, refImages: 1, mask: true },
    defaults: { duration_s: 5, steps: 4, cfg: 1.0, strength: 1.0 },
    frames: (d) => wanFrames(d, 16),
    build(ctx) {
      const control = ctx.videos.control_video || ctx.videos.pose_video;
      if (!control) throw Object.assign(new Error("视频指令编辑需要 1 段源视频（refs.control_video）"), { code: "PARAM_INVALID" });
      const length = wanFrames(ctx.params.duration_s ?? 5, 16);
      const shift = Number(ctx.params.shift ?? 5.0);
      const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.wanVaceHigh, weight_dtype: "default" } },
        "2": { class_type: "UNETLoader", inputs: { unet_name: M.wanVaceLow, weight_dtype: "default" } },
        "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: M.loraI2vHigh, strength_model: 1.0 } },
        "4": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: M.loraI2vLow, strength_model: 1.0 } },
        "5": { class_type: "ModelSamplingSD3", inputs: { model: ["3", 0], shift } },
        "6": { class_type: "ModelSamplingSD3", inputs: { model: ["4", 0], shift } },
        "7": { class_type: "CLIPLoader", inputs: { clip_name: M.wanClip, type: "wan", device: "default" } },
        "8": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: ctx.prompt } },
        "9": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: negative(ctx) } },
        "10": { class_type: "VAELoader", inputs: { vae_name: M.wanVae } },
        "12": { class_type: "LoadVideo", inputs: { file: control } },
        "13": { class_type: "GetVideoComponents", inputs: { video: ["12", 0] } },
      };
      const vaceInputs = {
        positive: ["8", 0], negative: ["9", 0], vae: ["10", 0],
        width: ctx.width, height: ctx.height, length, batch_size: ctx.batchSize,
        strength: ctx.params.strength ?? 1.0, control_video: ["13", 0] };
      if (ctx.images.mask) {
        wf["20"] = { class_type: "LoadImageMask", inputs: { image: ctx.images.mask, channel: "alpha" } };
        vaceInputs.control_masks = ["20", 0];
      }
      if (ctx.images.reference || ctx.images.character) {
        wf["21"] = { class_type: "LoadImage", inputs: { image: ctx.images.reference || ctx.images.character } };
        vaceInputs.reference_image = ["21", 0];
      }
      wf["14"] = { class_type: "WanVaceToVideo", inputs: vaceInputs };
      wf["15"] = { class_type: "KSamplerAdvanced", inputs: {
        model: ["5", 0], add_noise: "enable", noise_seed: seed(ctx),
        steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
        positive: ["14", 0], negative: ["14", 1], latent_image: ["14", 2],
        start_at_step: 0, end_at_step: 2, return_with_leftover_noise: "enable" } };
      wf["16"] = { class_type: "KSamplerAdvanced", inputs: {
        model: ["6", 0], add_noise: "disable", noise_seed: seed(ctx),
        steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0, sampler_name: "euler", scheduler: "simple",
        positive: ["14", 0], negative: ["14", 1], latent_image: ["15", 0],
        start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: "disable" } };
      wf["17"] = { class_type: "VAEDecode", inputs: { samples: ["16", 0], vae: ["10", 0] } };
      wf["18"] = { class_type: "CreateVideo", inputs: { images: ["17", 0], fps: 16 } };
      wf["19"] = { class_type: "SaveVideo", inputs: {
        video: ["18", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } };
      return wf;
    },
  },

  // ======================== WF-15 MiniMax-H3 原生 20 秒 + 音画同步（首帧驱动）
  "WF-15": {
    id: "WF-15",
    label: "原生 20 秒 · 音画同步（MiniMax-H3 I2V）",
    kind: "video",
    engine: "minimax_h3",
    mode: "i2v",
    fps: 24,
    hasAudio: true,
    sizeStep: 32,
    vramClass: "exclusive",
    vramNeedMB: 46000,
    maxDurationS: 20,
    supports: { image2video: true, nativeAudio: true, multiShot: true, firstLastFrame: true, refImages: 2, maxRefs: { images: 9, videos: 3, audios: 3 } },
    defaults: { duration_s: 5, steps: 8, fps: 24 },
    frames: (d) => minimaxFrames(d, 24),
    build(ctx) {
      const first = ctx.images.start_image || firstImage(ctx);
      if (!first) throw Object.assign(new Error("MiniMax-H3 图生视频需要 1 张首帧图（refs.start_image）"), { code: "PARAM_INVALID" });
      const length = minimaxFrames(ctx.params.duration_s ?? 5, 24);
      const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.mmFl2va, weight_dtype: "default" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: M.mmClip, type: "minimax", device: "default" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: M.mmVae } },
        "4": { class_type: "VAELoader", inputs: { vae_name: M.mmAudioVae } },
        "6": { class_type: "LoadImage", inputs: { image: first } },
      };
      let modelRef = ["1", 0];
      const steps = ctx.params.steps ?? 8;
      if (ctx.params.turbo !== false && steps <= 8) {
        wf["5"] = { class_type: "LoraLoaderModelOnly", inputs: {
          model: ["1", 0], lora_name: M.mmTurbo, strength_model: 1.0 } };
        modelRef = ["5", 0];
      }
      const i2vInputs = {
        clip: ["2", 0], vae: ["3", 0], prompt: ctx.prompt,
        width: ctx.width, height: ctx.height, length, first_frame: ["6", 0] };
      if (ctx.images.end_image) {
        wf["7b"] = { class_type: "LoadImage", inputs: { image: ctx.images.end_image } };
        i2vInputs.last_frame = ["7b", 0];
      }
      wf["7"] = { class_type: "MiniMaxH3ImageToVideo", inputs: i2vInputs };
      let condRef = ["7", 0];
      if (Array.isArray(ctx.params.guides) && ctx.params.guides.length) {
        ctx.params.guides.slice(0, 6).forEach((g, i) => {
          const id = `7g${i}`;
          const gi = { positive: condRef, latent: ["7", 1], frame_idx: Number(g.frame_idx || 0) };
          if (g.image) { wf[`${id}i`] = { class_type: "LoadImage", inputs: { image: g.image } }; gi.vae = ["3", 0]; gi.image = [`${id}i`, 0]; }
          if (g.audio) { wf[`${id}a`] = { class_type: "LoadAudio", inputs: { audio: g.audio } }; gi.audio_vae = ["4", 0]; gi.audio = [`${id}a`, 0]; }
          wf[id] = { class_type: "MiniMaxH3AddGuide", inputs: gi };
          condRef = [id, 0];
        });
      }
      wf["8"] = { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } };
      wf["9"] = { class_type: "BasicScheduler", inputs: { model: modelRef, scheduler: "simple", steps, denoise: 1.0 } };
      wf["10"] = { class_type: "BasicGuider", inputs: { model: modelRef, conditioning: condRef } };
      wf["11"] = { class_type: "RandomNoise", inputs: { noise_seed: seed(ctx) } };
      wf["12"] = { class_type: "SamplerCustomAdvanced", inputs: {
        noise: ["11", 0], guider: ["10", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["7", 1] } };
      wf["13"] = { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["3", 0] } };
      wf["14"] = { class_type: "VAEDecodeAudio", inputs: { samples: ["12", 0], vae: ["4", 0] } };
      wf["15"] = { class_type: "CreateVideo", inputs: { images: ["13", 0], fps: 24, audio: ["14", 0] } };
      wf["16"] = { class_type: "SaveVideo", inputs: {
        video: ["15", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } };
      return wf;
    },
  },

  // ======================== WF-15T MiniMax-H3 文生视频（t2va：文字 → 画面 + 声音）
  // 实机 comfy_extras/nodes_minimax_h3.py 里 MiniMaxH3ImageToVideo 的文档串是
  // "t2va and fl2va: prompt (+ optional first/last keyframes)"：first_frame / last_frame
  // 都是**可选**输入，不给关键帧时它只走 _empty_av_latent(...) 的空潜变量 + 文本条件，
  // 渲染出来就是纯文生视频（并且和 WF-15 一样原生带音轨）。
  // 所以 222 上的 MiniMax-H3 权重本来就够用，不需要另下 T2V 权重。
  "WF-15T": {
    id: "WF-15T",
    label: "文生视频 · 音画同步（MiniMax-H3 T2V 原生 20 秒）",
    kind: "video",
    engine: "minimax_h3",
    mode: "t2v",
    fps: 24,
    hasAudio: true,
    sizeStep: 32,
    vramClass: "exclusive",
    vramNeedMB: 46000,
    maxDurationS: 20,
    supports: { text2video: true, nativeAudio: true, multiShot: true, refImages: 0, refVideos: 0, refAudios: 0 },
    defaults: { duration_s: 5, steps: 8, fps: 24 },
    frames: (d) => minimaxFrames(d, 24),
    build(ctx) {
      const length = minimaxFrames(ctx.params.duration_s ?? 5, 24);
      const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.mmFl2va, weight_dtype: "default" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: M.mmClip, type: "minimax", device: "default" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: M.mmVae } },
        "4": { class_type: "VAELoader", inputs: { vae_name: M.mmAudioVae } },
      };
      let modelRef = ["1", 0];
      const steps = ctx.params.steps ?? 8;
      if (ctx.params.turbo !== false && steps <= 8) {
        wf["5"] = { class_type: "LoraLoaderModelOnly", inputs: {
          model: ["1", 0], lora_name: M.mmTurbo, strength_model: 1.0 } };
        modelRef = ["5", 0];
      }
      // 关键差异：不接 first_frame / last_frame，让节点走纯文本分支（空 AV 潜变量）
      wf["7"] = { class_type: "MiniMaxH3ImageToVideo", inputs: {
        clip: ["2", 0], vae: ["3", 0], prompt: ctx.prompt,
        width: ctx.width, height: ctx.height, length } };
      wf["8"] = { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } };
      wf["9"] = { class_type: "BasicScheduler", inputs: { model: modelRef, scheduler: "simple", steps, denoise: 1.0 } };
      wf["10"] = { class_type: "BasicGuider", inputs: { model: modelRef, conditioning: ["7", 0] } };
      wf["11"] = { class_type: "RandomNoise", inputs: { noise_seed: seed(ctx) } };
      wf["12"] = { class_type: "SamplerCustomAdvanced", inputs: {
        noise: ["11", 0], guider: ["10", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["7", 1] } };
      wf["13"] = { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["3", 0] } };
      wf["14"] = { class_type: "VAEDecodeAudio", inputs: { samples: ["12", 0], vae: ["4", 0] } };
      wf["15"] = { class_type: "CreateVideo", inputs: { images: ["13", 0], fps: 24, audio: ["14", 0] } };
      wf["16"] = { class_type: "SaveVideo", inputs: {
        video: ["15", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } };
      return wf;
    },
  },
  // ============== WF-15R MiniMax-H3 参考素材生视频（≤9 图 + 3 视频 + 3 音频）
  "WF-15R": {
    id: "WF-15R",
    label: "参考素材生视频 · 角色锁定（MiniMax-H3 ref2va）",
    kind: "video",
    engine: "minimax_h3",
    mode: "ref2v",
    fps: 24,
    hasAudio: true,
    sizeStep: 32,
    vramClass: "exclusive",
    vramNeedMB: 46000,
    maxDurationS: 20,
    supports: { reference: true, nativeAudio: true, refImages: 9, refVideos: 3, refAudios: 3, maxRefs: { images: 9, videos: 3, audios: 3 } },
    defaults: { duration_s: 5, steps: 8, fps: 24 },
    frames: (d) => minimaxFrames(d, 24),
    build(ctx) {
      const length = minimaxFrames(ctx.params.duration_s ?? 5, 24);
      if (!ctx.imageList.length && !ctx.videoList.length) {
        throw Object.assign(new Error("参考生视频至少需要 1 个参考素材"), { code: "PARAM_INVALID" });
      }
      const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.mmRef2va, weight_dtype: "default" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: M.mmClip, type: "minimax", device: "default" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: M.mmVae } },
        "4": { class_type: "VAELoader", inputs: { vae_name: M.mmAudioVae } },
      };
      let modelRef = ["1", 0];
      const steps = ctx.params.steps ?? 8;
      if (ctx.params.turbo !== false && steps <= 8) {
        wf["5"] = { class_type: "LoraLoaderModelOnly", inputs: {
          model: ["1", 0], lora_name: M.mmTurbo, strength_model: 1.0 } };
        modelRef = ["5", 0];
      }
      const inputs = {
        clip: ["2", 0], vae: ["3", 0], audio_vae: ["4", 0], prompt: ctx.prompt,
        width: ctx.width, height: ctx.height, length,
        ref_image_size: ctx.params.ref_image_size || "match" };
      let n = 100;
      // 自动增长输入的提交名是「分组名.前缀+下标」，例如 ref_images.ref_image_0
      let imgIdx = 0; let vidIdx = 0; let audIdx = 0;
      ctx.imageList.slice(0, 9).forEach((img) => {
        const id = String(n++);
        wf[id] = { class_type: "LoadImage", inputs: { image: img } };
        inputs[`ref_images.ref_image_${imgIdx++}`] = [id, 0];
      });
      ctx.videoList.slice(0, 3).forEach((v) => {
        const id = String(n++);
        wf[id] = { class_type: "LoadVideo", inputs: { file: v } };
        // GetVideoComponents 输出 0=images、1=audio
        wf[`${id}c`] = { class_type: "GetVideoComponents", inputs: { video: [id, 0] } };
        inputs[`ref_videos.ref_video_${vidIdx}`] = [`${id}c`, 0];
        inputs[`ref_video_audios.ref_video_audio_${vidIdx}`] = [`${id}c`, 1];
        vidIdx += 1;
      });
      ctx.audioList.slice(0, 3).forEach((a) => {
        const id = String(n++);
        wf[id] = { class_type: "LoadAudio", inputs: { audio: a } };
        inputs[`ref_audios.ref_audio_${audIdx++}`] = [id, 0];
      });
      wf["7"] = { class_type: "MiniMaxH3ReferenceToVideo", inputs };
      wf["8"] = { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } };
      wf["9"] = { class_type: "BasicScheduler", inputs: { model: modelRef, scheduler: "simple", steps, denoise: 1.0 } };
      wf["10"] = { class_type: "BasicGuider", inputs: { model: modelRef, conditioning: ["7", 0] } };
      wf["11"] = { class_type: "RandomNoise", inputs: { noise_seed: seed(ctx) } };
      wf["12"] = { class_type: "SamplerCustomAdvanced", inputs: {
        noise: ["11", 0], guider: ["10", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["7", 1] } };
      wf["13"] = { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["3", 0] } };
      wf["14"] = { class_type: "VAEDecodeAudio", inputs: { samples: ["12", 0], vae: ["4", 0] } };
      wf["15"] = { class_type: "CreateVideo", inputs: { images: ["13", 0], fps: 24, audio: ["14", 0] } };
      wf["16"] = { class_type: "SaveVideo", inputs: {
        video: ["15", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } };
      return wf;
    },
  },

  // ================================================= WF-16 视频续长与拼接（最多 100 段）
  "WF-16": {
    id: "WF-16",
    label: "视频拼接 / 续长合片（ConcatenateVideo）",
    kind: "video",
    engine: "native",
    mode: "concat",
    fps: null,
    hasAudio: false,
    vramClass: "light",
    vramNeedMB: 8000,
    maxDurationS: 600,
    supports: { concat: true, refVideos: 100 },
    defaults: {},
    /**
     * ConcatenateVideo 的硬约束（实机核对 comfy_api/latest/_input_impl/video_types.py）：
     *   1. 所有片段的像素尺寸必须完全一致，否则报
     *      "Accumulated videos have incompatible frame dimensions: chunk 0 is 720x1280; chunk 21 is 736x1280"；
     *   2. 所有片段的帧率必须一致，否则 SaveVideo 封装时直接抛 pyav 的 "Invalid argument"；
     *   3. 音轨必须「全有」或「全无」，否则报 "expected None, got 32000"。
     *
     * 而这台机器上不同模型产出的规格并不统一：
     *   Wan 系列（WF-07~13）按 16 对齐 = 720x1280 @16fps、无音轨；
     *   MiniMax-H3（WF-15）与 LTX-2.5（WF-17）按 32 对齐 = 736x1280 @24fps、带音轨。
     *
     * 处理办法：主流规格（多数票）作为拼接目标，绝大多数片段原样直通、不重新编码；
     * 只把少数「异形」片段拆帧后缩放到目标尺寸，并按时间轴等比抽帧换算到目标帧率
     * （帧率不同时只改 fps 会让那一段变成慢动作，必须真的抽帧），再按目标帧率重新封装。
     */
    build(ctx) {
      const list = (ctx.params.videos && ctx.params.videos.length ? ctx.params.videos : ctx.videoList).slice(0, 100);
      if (list.length < 1) throw Object.assign(new Error("拼接需要至少 1 段视频（refs.videos）"), { code: "PARAM_INVALID" });

      // 每一段的真实参数：先按上传后的文件名匹配，再按素材 id，最后按下标兜底
      const meta = ctx.videoMeta || [];
      const infos = list.map((entry, i) =>
        meta.find((m) => m.file === entry) || meta.find((m) => m.assetId === entry) || meta[i] || null);

      const target = pickTargetSize(infos) || ctx.aspectGenSize || { width: 720, height: 1280 };
      const targetFps = pickTargetFps(infos) || 16;

      // 分段音轨参差不齐时 ConcatenateVideo 会直接失败；有 BGM 时它整轨覆盖，就不用管了
      const hasBgm = !!(ctx.audios.bgm || ctx.audios.audio);
      const known = infos.filter(Boolean);
      const audioUniform = !known.length
        || known.every((s) => !!s.hasAudio) || known.every((s) => !s.hasAudio);

      const sizeOk = (s) => !!s && s.width === target.width && s.height === target.height;
      const fpsOk = (s) => !!s && !!s.fps && Math.abs(s.fps - targetFps) < 0.05;
      const dropAudio = (s) => !hasBgm && !audioUniform && !!s && !!s.hasAudio;
      const needsConform = (s) => !s || !s.width || !s.height || !sizeOk(s) || !fpsOk(s) || dropAudio(s);
      // 抽帧后要保留多少帧：按时间轴等比换算，不能多保留（否则那一段会变慢）
      const targetFrames = (s) => {
        if (!s || !s.frames || !s.fps || !targetFps) return null;
        return Math.max(1, Math.min(s.frames, Math.round((s.frames * targetFps) / s.fps)));
      };

      const wf = {};
      const refs = [];
      list.forEach((file, i) => {
        const loadId = String(100 + i);
        wf[loadId] = { class_type: "LoadVideo", inputs: { file: file } };
        const info = infos[i];
        if (!needsConform(info)) { refs.push([loadId, 0]); return; }

        // 帧率不一致：先按时间轴等比抽帧，再做后面的缩放与重新封装
        let frameRef = [loadId, 0];
        if (!fpsOk(info)) {
          const sampId = String(300 + i);
          wf[sampId] = { class_type: "VideoFrameSample", inputs: {
            video: [loadId, 0], num_frames: targetFrames(info) || 9999, strategy: "uniform", seed: 0 } };
          frameRef = [sampId, 0];
        }

        // 拆帧 → 缩放到目标尺寸 → 按目标帧率重新封装
        const compId = String(200 + i);
        const scaleId = String(400 + i);
        const makeId = String(500 + i);
        wf[compId] = { class_type: "GetVideoComponents", inputs: { video: frameRef } };
        wf[scaleId] = { class_type: "ImageScale", inputs: {
          image: [compId, 0], upscale_method: "lanczos",
          width: target.width, height: target.height, crop: "disabled" } };
        const makeInputs = { images: [scaleId, 0], fps: targetFps };
        // 音轨本来就统一、也没有 BGM 要覆盖时，把这一段的音轨原样带过去
        if (!dropAudio(info) && info && info.hasAudio) makeInputs.audio = [compId, 1];
        wf[makeId] = { class_type: "CreateVideo", inputs: makeInputs };
        refs.push([makeId, 0]);
      });

      const hasAudio = list.some((_, i) => {
        const s = infos[i];
        return !dropAudio(s) && !!s && !!s.hasAudio;
      });
      const inputs = { codec: "h264" };
      // ConcatenateVideo 的自动增长输入提交名是 videos.video0 / videos.video1 …
      refs.forEach((r, i) => { inputs["videos.video" + i] = r; });
      if (ctx.audios.bgm || ctx.audios.audio) {
        wf["600"] = { class_type: "LoadAudio", inputs: { audio: ctx.audios.bgm || ctx.audios.audio } };
        inputs.complete_audio = ["600", 0];
      }
      wf["900"] = { class_type: "ConcatenateVideo", inputs: inputs };
      wf["901"] = { class_type: "SaveVideo", inputs: {
        video: ["900", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } };

      // 把归一化情况回报给宿主，便于日志与前端提示
      ctx._concatReport = {
        total: list.length,
        conformed: list.filter((_, i) => needsConform(infos[i])).length,
        target: target,
        targetFps: targetFps,
        audio: hasBgm ? "bgm" : (hasAudio ? "keep" : "none"),
      };
      return wf;
    },
  },
  // ================== WF-17 LTX-2.5 音视频联合生成（长镜头 + 原生音轨，首尾帧）
  "WF-17": {
    id: "WF-17",
    label: "音画同步 · 长镜头（LTX-2.5 AV，首尾帧）",
    kind: "video",
    engine: "ltx25",
    mode: "flf2v",
    fps: 24,
    hasAudio: true,
    sizeStep: 32,
    vramClass: "exclusive",
    vramNeedMB: 46000,
    maxDurationS: 20,
    supports: { image2video: true, nativeAudio: true, firstLastFrame: true, refImages: 2 },
    defaults: { duration_s: 5, fps: 24 },
    frames: (d) => ltxFrames(d, 24),
    build(ctx) {
      const first = ctx.images.start_image || firstImage(ctx);
      if (!first) throw Object.assign(new Error("LTX-2.5 需要 1 张起始图（refs.start_image）"), { code: "PARAM_INVALID" });
      const length = ltxFrames(ctx.params.duration_s ?? 5, 24);
      const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.ltx25Unet, weight_dtype: "default" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: M.ltx25Clip, type: "ltxv", device: "default" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: M.ltx25Vae } },
        "4": { class_type: "LTXVAudioVAELoader", inputs: { ckpt_name: M.ltx25AudioVae } },
        "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: ctx.prompt } },
        "6": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative(ctx) } },
        "7": { class_type: "EmptyLTXVLatentVideo", inputs: {
          width: ctx.width, height: ctx.height, length, batch_size: ctx.batchSize } },
        "8": { class_type: "LTXVEmptyLatentAudio", inputs: {
          frames_number: length, frame_rate: 24.0, batch_size: ctx.batchSize, audio_vae: ["4", 0] } },
        "9": { class_type: "LTXVConditioning", inputs: { positive: ["5", 0], negative: ["6", 0], frame_rate: 24.0 } },
        "10": { class_type: "LoadImage", inputs: { image: first } },
        "12": { class_type: "LTXVAddGuide", inputs: {
          positive: ["9", 0], negative: ["9", 1], vae: ["3", 0], latent: ["7", 0],
          image: ["10", 0], frame_idx: 0, strength: 1.0 } },
      };
      let posRef = ["12", 0];
      let negRef = ["12", 1];
      let latRef = ["12", 2];
      if (ctx.images.end_image) {
        wf["11"] = { class_type: "LoadImage", inputs: { image: ctx.images.end_image } };
        wf["13"] = { class_type: "LTXVAddGuide", inputs: {
          positive: posRef, negative: negRef, vae: ["3", 0], latent: latRef,
          image: ["11", 0], frame_idx: -1, strength: 1.0 } };
        posRef = ["13", 0]; negRef = ["13", 1]; latRef = ["13", 2];
      }
      wf["14"] = { class_type: "LTXVConcatAVLatent", inputs: { video_latent: latRef, audio_latent: ["8", 0] } };
      wf["15"] = { class_type: "ManualSigmas", inputs: {
        sigmas: ctx.params.sigmas || "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0" } };
      wf["16"] = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler_ancestral" } };
      wf["17"] = { class_type: "LTXVDualCFGGuider", inputs: {
        model: ["1", 0], positive: posRef, negative: negRef,
        video_cfg: Number(ctx.params.video_cfg ?? 1.0), audio_cfg: Number(ctx.params.audio_cfg ?? 1.0) } };
      wf["18"] = { class_type: "RandomNoise", inputs: { noise_seed: seed(ctx) } };
      wf["19"] = { class_type: "SamplerCustomAdvanced", inputs: {
        noise: ["18", 0], guider: ["17", 0], sampler: ["16", 0], sigmas: ["15", 0], latent_image: ["14", 0] } };
      wf["20"] = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["19", 0] } };
      wf["21"] = { class_type: "VAEDecodeTiled", inputs: {
        samples: ["20", 0], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } };
      wf["22"] = { class_type: "LTXVAudioVAEDecode", inputs: { samples: ["20", 1], audio_vae: ["4", 0] } };
      wf["23"] = { class_type: "CreateVideo", inputs: { images: ["21", 0], fps: 24, audio: ["22", 0] } };
      wf["24"] = { class_type: "SaveVideo", inputs: {
        video: ["23", 0], filename_prefix: ctx.prefix, format: "auto", codec: "auto" } };
      return wf;
    },
  },
};

module.exports = { videoWorkflows, CAMERA_POSES, cameraPose, frames };
