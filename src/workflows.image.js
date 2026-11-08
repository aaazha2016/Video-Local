"use strict";
/**
 * 工作流注册表（对应需求报告第 3 / 7 / 8 章）
 * - 每个 WF 都是一个 builder：接收归一化参数 ctx，产出 API 格式工作流 JSON
 * - 模型文件名与需求报告 §2 的实机清单一字不差
 * - 参数对齐规则见报告 §7.5
 */

// ---------- 实测可用权重（引用名 == ComfyUI COMBO 选项名） ----------
const M = {
  // 图像
  zImage: "z-image-turbo-fp8-e4m3fn.safetensors",
  zImageFunCn: "Z-Image-Turbo-Fun-Controlnet-Union-2.1-2601-8steps.safetensors",
  zImageClip: "qwen_3_4b.safetensors",
  zImageVae: "ae.safetensors",
  qwenImage: "qwen_image_fp8_e4m3fn.safetensors",
  qwenEdit: "qwen_image_edit_2511_fp8mixed.safetensors",
  qwenClip: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
  qwenVae: "qwen_image_vae.safetensors",
  qwenLoraFast: "Qwen-Image-Lightning-4steps-V2.0-bf16.safetensors",
  qwenEditLoraFast: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
  qwenEditLoraConsist: "qe2511_consis_alpha_patched.safetensors",
  netayume: "NetaYumev35_pretrained_all_in_one.safetensors",
  upscale4x: "4xRealWebPhoto_v3_atd.pth",
  seedvr2Unet: "seedvr2_ema_3b_fp16.safetensors",
  seedvr2Vae: "ema_vae_fp16.safetensors",

  // Wan 2.2
  wanI2vHigh: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
  wanI2vLow: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
  wanT2vHigh: "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors",
  wanT2vLow: "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors",
  wanVaceHigh: "wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors",
  wanVaceLow: "wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors",
  wanInpaintHigh: "wan2.2_fun_inpaint_high_noise_14B_fp8_scaled.safetensors",
  wanInpaintLow: "wan2.2_fun_inpaint_low_noise_14B_fp8_scaled.safetensors",
  wanCameraHigh: "wan2.2_fun_camera_high_noise_14B_fp8_scaled.safetensors",
  wanCameraLow: "wan2.2_fun_camera_low_noise_14B_fp8_scaled.safetensors",
  wanS2v: "wan2.2_s2v_14B_fp8_scaled.safetensors",
  wanAnimate: "Wan2_2-Animate-14B_fp8_scaled_e4m3fn_KJ_v2.safetensors",
  wanAnimateLight: "wan2.2_animate_14B_relight_lora_bf16.safetensors",
  wanClip: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  wanVae: "wan_2.1_vae.safetensors",
  wav2vec: "wav2vec2_large_english_fp16.safetensors",
  loraI2vHigh: "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
  loraI2vLow: "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
  loraT2vHigh: "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors",
  loraT2vLow: "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors",

  // MiniMax-H3
  mmFl2va: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  mmRef2va: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  mmClip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  // 注意：int8 VAE 的解码会走 comfy_kitchen 的 int8 attention kernel，驱动 <560 时
  // 直接 "kernel launch failed: CUDA driver version is insufficient"（实测本机 550.163.01），
  // 因此默认改用 fp16 VAE；确认驱动已升级后可切回 mmVaeInt8 省显存。
  mmVae: "minimax_h3_video_vae_fp16.safetensors",
  mmVaeInt8: "minimax_h3_video_vae_int8_convrot.safetensors",
  mmAudioVae: "minimax_h3_audio_vae_fp32.safetensors",
  mmTurbo: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
  mmCn: "minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors",
  mmTurbo4: "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",

  // LTX-2.5（长视频 + 音视频联合生成）
  ltx25Unet: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
  ltx25Clip: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
  ltx25Vae: "ltx-2.5-video-vae-bf16.safetensors",
  ltx25AudioVae: "ltx-2.5-audio-vae-bf16.safetensors",

  // 音频 / BGM
  music3Clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
};

// ---------- 对齐工具（报告 §7.5） ----------
const alignUp = (v, m) => Math.max(m, Math.round(Number(v) / m) * m);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)));

/** Wan 2.x：length = 4n + 1 */
function wanFrames(durationS, fps = 16) {
  const raw = Math.round(clamp(durationS, 1, 30) * fps) + 1;
  const n = Math.max(2, Math.round((raw - 1) / 4));
  return n * 4 + 1;
}
/** MiniMax-H3：官方表达式 max(5, round(sec*24)) + (5 - (x % 17)) % 17 */
function minimaxFrames(durationS, fps = 24) {
  const x = Math.max(5, Math.round(clamp(durationS, 0.2, 150) * fps));
  return x + ((5 - (x % 17)) % 17);
}
/** LTX：length = 8n + 1 */
function ltxFrames(durationS, fps = 24) {
  const raw = Math.round(clamp(durationS, 0.5, 30) * fps) + 1;
  const n = Math.max(1, Math.round((raw - 1) / 8));
  return n * 8 + 1;
}
function aspectSize(aspect, aspects, { forVideo = false } = {}) {
  const a = aspects[aspect] || aspects["9:16"];
  if (!forVideo) return { width: a.genWidth, height: a.genHeight, outWidth: a.outWidth, outHeight: a.outHeight };
  return { width: a.genWidth, height: a.genHeight, outWidth: a.outWidth, outHeight: a.outHeight };
}

// 负向提示词基线（报告 §13.1）
const BASE_NEGATIVE = "模糊, 低分辨率, 畸变, 多余手指, 肢体错乱, 文字, 水印, logo, 过曝, 欠曝, 压缩伪影, 廉价感";

const seed = (ctx) => (Number.isFinite(ctx.params.seed) && ctx.params.seed >= 0 ? Math.floor(ctx.params.seed) : Math.floor(Math.random() * 2 ** 40));
const negative = (ctx) => [BASE_NEGATIVE, ctx.params.negative_prompt || "", ctx.style?.negative || ""].filter(Boolean).join(", ");

// ---------- 图像工作流 ----------
const imageWorkflows = {
  "WF-01A": {
    id: "WF-01A",
    label: "极速文生图（Z-Image Turbo）",
    kind: "image",
    engine: "z_image",
    vramClass: "light",
    vramNeedMB: 18000,
    supports: { text2image: true, refImages: 0, mask: false },
    defaults: { steps: 8, cfg: 1.0 },
    build(ctx) {
      const s = seed(ctx);
      return {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.zImage, weight_dtype: "default" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: M.zImageClip, type: "lumina2", device: "default" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: M.zImageVae } },
        "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.0 } },
        "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: ctx.prompt } },
        "6": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative(ctx) } },
        "7": { class_type: "EmptyLatentImage", inputs: { width: ctx.width, height: ctx.height, batch_size: ctx.batchSize } },
        "8": { class_type: "KSampler", inputs: {
          model: ["4", 0], seed: s, steps: ctx.params.steps ?? 8, cfg: ctx.params.cfg ?? 1.0,
          sampler_name: "res_multistep", scheduler: "simple",
          positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], denoise: 1.0 } },
        "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
        "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: ctx.prefix } },
      };
    },
  },

  "WF-01B": {
    id: "WF-01B",
    label: "高质量文生图（Qwen-Image）",
    kind: "image",
    engine: "qwen_image",
    vramClass: "heavy",
    vramNeedMB: 34000,
    supports: { text2image: true, refImages: 0 },
    defaults: { steps: 4, cfg: 1.0 },
    build(ctx) {
      const fast = ctx.params.fast !== false;
      const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.qwenImage, weight_dtype: "default" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: M.qwenClip, type: "qwen_image", device: "default" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: M.qwenVae } },
        "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.1 } },
      };
      let modelRef = ["4", 0];
      if (fast) {
        wf["5"] = { class_type: "LoraLoaderModelOnly", inputs: { model: modelRef, lora_name: M.qwenLoraFast, strength_model: 1.0 } };
        modelRef = ["5", 0];
      }
      Object.assign(wf, {
        "6": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: ctx.prompt } },
        "7": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative(ctx) } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: ctx.width, height: ctx.height, batch_size: ctx.batchSize } },
        "9": { class_type: "KSampler", inputs: {
          model: modelRef, seed: seed(ctx), steps: ctx.params.steps ?? (fast ? 4 : 24),
          cfg: ctx.params.cfg ?? (fast ? 1.0 : 4.0),
          sampler_name: "euler", scheduler: "simple",
          positive: ["6", 0], negative: ["7", 0], latent_image: ["8", 0], denoise: 1.0 } },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0], filename_prefix: ctx.prefix } },
      });
      return wf;
    },
  },

  "WF-01C": {
    id: "WF-01C",
    label: "二次元立绘（NetaYume v3.5）",
    kind: "image",
    engine: "netayume",
    vramClass: "medium",
    vramNeedMB: 24000,
    supports: { text2image: true, refImages: 0 },
    defaults: { steps: 30, cfg: 4.0 },
    build(ctx) {
      return {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: M.netayume } },
        "2": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 4.0 } },
        "3": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: ctx.prompt } },
        "4": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: negative(ctx) } },
        "5": { class_type: "EmptyLatentImage", inputs: { width: ctx.width, height: ctx.height, batch_size: ctx.batchSize } },
        "6": { class_type: "KSampler", inputs: {
          model: ["2", 0], seed: seed(ctx), steps: ctx.params.steps ?? 30, cfg: ctx.params.cfg ?? 4.0,
          sampler_name: "res_multistep", scheduler: "simple",
          positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0], denoise: 1.0 } },
        "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
        "8": { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: ctx.prefix } },
      };
    },
  },

  "WF-02": {
    id: "WF-02",
    label: "指令改图 / 多图参考（Qwen-Image-Edit-2511）",
    kind: "image",
    engine: "qwen_edit",
    vramClass: "heavy",
    vramNeedMB: 34000,
    supports: { image2image: true, refImages: 3, maxRefImages: 20 },
    defaults: { steps: 4, cfg: 1.0, denoise: 0.7 },
    build(ctx) {
      const refs = (ctx.refImages || []).slice(0, 3);
      if (!refs.length) throw Object.assign(new Error("图生图/图像编辑至少需要 1 张参考图"), { code: "PARAM_INVALID" });
      const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.qwenEdit, weight_dtype: "default" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: M.qwenClip, type: "qwen_image", device: "default" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: M.qwenVae } },
        "4": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: M.qwenEditLoraFast, strength_model: 1.0 } },
      };
      let modelRef = ["4", 0];
      if (ctx.params.consistency !== false) {
        wf["5"] = { class_type: "LoraLoaderModelOnly", inputs: {
          model: modelRef, lora_name: M.qwenEditLoraConsist,
          strength_model: ctx.params.consistency_strength ?? 0.8 } };
        modelRef = ["5", 0];
      }
      let loadId = 6;
      const loadIds = [];
      for (const r of refs) {
        wf[String(loadId)] = { class_type: "LoadImage", inputs: { image: r } };
        loadIds.push(String(loadId));
        loadId += 1;
      }
      const encodeInputs = { clip: ["2", 0], prompt: ctx.prompt, vae: ["3", 0] };
      loadIds.forEach((id, i) => { encodeInputs[`image${i + 1}`] = [id, 0]; });
      wf[String(loadId)] = { class_type: "TextEncodeQwenImageEditPlus", inputs: encodeInputs };
      const encId = String(loadId); loadId += 1;
      wf[String(loadId)] = { class_type: "VAEEncode", inputs: { pixels: [loadIds[0], 0], vae: ["3", 0] } };
      const latId = String(loadId); loadId += 1;
      wf[String(loadId)] = { class_type: "KSampler", inputs: {
        model: modelRef, seed: seed(ctx), steps: ctx.params.steps ?? 4, cfg: ctx.params.cfg ?? 1.0,
        sampler_name: "euler", scheduler: "simple",
        positive: [encId, 0], negative: [encId, 0], latent_image: [latId, 0],
        denoise: ctx.params.denoise ?? 0.7 } };
      const ksamplerId = String(loadId); loadId += 1;
      wf[String(loadId)] = { class_type: "VAEDecode", inputs: { samples: [ksamplerId, 0], vae: ["3", 0] } };
      wf[String(loadId + 1)] = { class_type: "SaveImage", inputs: { images: [String(loadId), 0], filename_prefix: ctx.prefix } };
      return wf;
    },
  },

  "WF-04": {
    id: "WF-04",
    label: "图片局部重绘（Z-Image Fun ControlNet）",
    kind: "image",
    engine: "z_image",
    vramClass: "medium",
    vramNeedMB: 26000,
    supports: { inpaint: true, refImages: 2, mask: true },
    defaults: { steps: 8, cfg: 1.0, denoise: 0.85 },
    build(ctx) {
      if (!ctx.refImages?.length) throw Object.assign(new Error("局部重绘需要底图"), { code: "PARAM_INVALID" });
      if (!ctx.maskImage) throw Object.assign(new Error("局部重绘需要遮罩（mask，白=重绘区）"), { code: "PARAM_INVALID" });
      const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.zImage, weight_dtype: "default" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: M.zImageClip, type: "lumina2", device: "default" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: M.zImageVae } },
        "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.0 } },
        "5": { class_type: "ModelPatchLoader", inputs: { name: M.zImageFunCn } },
        "6": { class_type: "LoadImage", inputs: { image: ctx.refImages[0] } },
        "7": { class_type: "LoadImageMask", inputs: { image: ctx.maskImage, channel: "alpha" } },
        "8": { class_type: "ZImageFunControlnet", inputs: {
          model: ["4", 0], model_patch: ["5", 0], vae: ["3", 0],
          strength: ctx.params.cn_strength ?? 1.0,
          image: ["6", 0], inpaint_image: ["6", 0], mask: ["7", 0],
          start_percent: 0.0, end_percent: 1.0 } },
        "9": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: ctx.prompt } },
        "10": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative(ctx) } },
        "11": { class_type: "VAEEncode", inputs: { pixels: ["6", 0], vae: ["3", 0] } },
        "12": { class_type: "KSampler", inputs: {
          model: ["8", 0], seed: seed(ctx), steps: ctx.params.steps ?? 8, cfg: ctx.params.cfg ?? 1.0,
          sampler_name: "res_multistep", scheduler: "simple",
          positive: ["9", 0], negative: ["10", 0], latent_image: ["11", 0],
          denoise: ctx.params.denoise ?? 0.85 } },
        "13": { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["3", 0] } },
        "14": { class_type: "SaveImage", inputs: { images: ["13", 0], filename_prefix: ctx.prefix } },
      };
      return wf;
    },
  },

  "WF-05": {
    id: "WF-05",
    label: "图片扩图（Outpaint）",
    kind: "image",
    engine: "z_image",
    vramClass: "medium",
    vramNeedMB: 26000,
    supports: { outpaint: true, refImages: 1 },
    defaults: { steps: 8, cfg: 1.0, denoise: 0.8 },
    build(ctx) {
      if (!ctx.refImages?.length) throw Object.assign(new Error("扩图需要底图"), { code: "PARAM_INVALID" });
      const pad = ctx.params.pad || {};
      const left = pad.left ?? 0, top = pad.top ?? 0, right = pad.right ?? 256, bottom = pad.bottom ?? 256;
      return {
        "1": { class_type: "UNETLoader", inputs: { unet_name: M.zImage, weight_dtype: "default" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: M.zImageClip, type: "lumina2", device: "default" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: M.zImageVae } },
        "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.0 } },
        "5": { class_type: "ModelPatchLoader", inputs: { name: M.zImageFunCn } },
        "6": { class_type: "LoadImage", inputs: { image: ctx.refImages[0] } },
        "7": { class_type: "ImagePadForOutpaint", inputs: {
          image: ["6", 0], left, top, right, bottom, feathering: ctx.params.feathering ?? 40 } },
        "8": { class_type: "ZImageFunControlnet", inputs: {
          model: ["4", 0], model_patch: ["5", 0], vae: ["3", 0],
          strength: ctx.params.cn_strength ?? 1.0,
          image: ["7", 0], mask: ["7", 1],
          start_percent: 0.0, end_percent: 1.0 } },
        "9": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: ctx.prompt } },
        "10": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative(ctx) } },
        "11": { class_type: "VAEEncode", inputs: { pixels: ["7", 0], vae: ["3", 0] } },
        "12": { class_type: "KSampler", inputs: {
          model: ["8", 0], seed: seed(ctx), steps: ctx.params.steps ?? 8, cfg: ctx.params.cfg ?? 1.0,
          sampler_name: "res_multistep", scheduler: "simple",
          positive: ["9", 0], negative: ["10", 0], latent_image: ["11", 0],
          denoise: ctx.params.denoise ?? 0.8 } },
        "13": { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["3", 0] } },
        "14": { class_type: "SaveImage", inputs: { images: ["13", 0], filename_prefix: ctx.prefix } },
      };
    },
  },

  "WF-06": {
    id: "WF-06",
    label: "高清放大（SeedVR2 / 4x 兜底）",
    kind: "image",
    engine: "seedvr2",
    vramClass: "medium",
    vramNeedMB: 20000,
    supports: { upscale: true, refImages: 1 },
    defaults: { multiplier: 2 },
    build(ctx) {
      if (!ctx.refImages?.length) throw Object.assign(new Error("放大需要输入图"), { code: "PARAM_INVALID" });
      const targetW = alignUp(ctx.params.target_width || ctx.width, 16);
      const targetH = alignUp(ctx.params.target_height || ctx.height, 16);
      // 实机核查：SeedVR2 权重未在 ComfyUI 注册（见报告 §15.2），默认走 4x 模型；
      // 仅在显式 params.engine = "seedvr2" 且权重就绪时才走 SeedVR2 分支
      if (ctx.params.engine !== "seedvr2" || ctx.fallbackUpscale) {
        return {
          "1": { class_type: "LoadImage", inputs: { image: ctx.refImages[0] } },
          "2": { class_type: "UpscaleModelLoader", inputs: { model_name: M.upscale4x } },
          "3": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } },
          "4": { class_type: "ImageScale", inputs: {
            image: ["3", 0], upscale_method: "lanczos", width: targetW, height: targetH, crop: "disabled" } },
          "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: ctx.prefix } },
        };
      }
      return {
        "1": { class_type: "LoadImage", inputs: { image: ctx.refImages[0] } },
        "2": { class_type: "ImageScale", inputs: { image: ["1", 0], upscale_method: "lanczos", width: targetW, height: targetH, crop: "disabled" } },
        "3": { class_type: "SeedVR2Preprocess", inputs: { resized_images: ["2", 0] } },
        "4": { class_type: "UNETLoader", inputs: { unet_name: M.seedvr2Unet, weight_dtype: "default" } },
        "5": { class_type: "VAELoader", inputs: { vae_name: M.seedvr2Vae } },
        "6": { class_type: "VAEEncodeTiled", inputs: { pixels: ["3", 0], vae: ["5", 0], tile_size: 512, overlap: 128, temporal_size: 4096, temporal_overlap: 8 } },
        "7": { class_type: "SeedVR2Conditioning", inputs: { model: ["4", 0], vae_conditioning: ["6", 0] } },
        "8": { class_type: "KSampler", inputs: {
          model: ["4", 0], seed: seed(ctx), steps: 1, cfg: 1.0,
          sampler_name: "euler", scheduler: "simple",
          positive: ["7", 0], negative: ["7", 1], latent_image: ["6", 0], denoise: 1.0 } },
        "9": { class_type: "VAEDecodeTiled", inputs: { samples: ["8", 0], vae: ["5", 0], tile_size: 512, overlap: 128, temporal_size: 4096, temporal_overlap: 8 } },
        "10": { class_type: "SeedVR2PostProcessing", inputs: {
          images: ["9", 0], original_resized_images: ["2", 0], color_correction_method: "none" } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0], filename_prefix: ctx.prefix } },
      };
    },
  },
};

module.exports = { M, imageWorkflows, alignUp, clamp, wanFrames, minimaxFrames, ltxFrames, aspectSize, BASE_NEGATIVE };

