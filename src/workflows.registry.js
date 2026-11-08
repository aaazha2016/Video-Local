"use strict";
/**
 * 工作流注册表 + 能力自检（需求报告 §3 能力矩阵、§15.2 缺口清单）。
 *
 * 能力自检的做法是"用探针参数把每个工作流真正装配一遍，再拿实机 /object_info
 * 逐字段核对"：节点是否存在、枚举/模型名是否在 COMBO 选项里。这样任何权重
 * 缺失（SeedVR2、LTX 音频 VAE、Music3、帧插值模型…）都会被自动识别，避免
 * 前端展示一个点了就报错的功能。自检结果按 config.comfy.objectInfoCacheSeconds 缓存。
 */

const config = require("./config");
const log = require("./logger").scope("registry");
const { imageWorkflows, M } = require("./workflows.image");
const { videoWorkflows } = require("./workflows.video");
const { audioWorkflows } = require("./workflows.audio");
const { textWorkflows } = require("./workflows.text");
const { vocalWorkflows } = require("./workflows.vocal");
const { musicWorkflows } = require("./workflows.music");

const workflows = {
  ...imageWorkflows,
  ...videoWorkflows,
  ...audioWorkflows,
  ...textWorkflows,
  ...vocalWorkflows,
  ...musicWorkflows,

};

/** 探针上下文：提供一份"最小可用素材"用于装配自检 */
function probeContext(wf) {
  const ref = (ext, n = 3) => Array.from({ length: n }, (_, i) => `__probe_${i}${ext}`);
  const images = ref(".png");
  const videos = ref(".mp4", 2);
  const audios = ref(".mp3", 2);
  return {
    workflowId: wf.id,
    params: { duration_s: 5, seed: 1, lyrics: "probe lyrics line one\nprobe lyrics line two", style: "probe style tags" },
    prompt: "probe prompt",
    negativePrompt: "",
    style: null,
    character: null,
    width: 720, height: 1280, batchSize: 1, prefix: "probe/probe",
    images: {
      start_image: images[0], end_image: images[1], character: images[0], mask: images[2],
      reference: images[0], source_video: videos[0], control_video: videos[0],
      pose_video: videos[1], bgm: audios[0], audio: audios[0], speech: audios[0],
    },
    videos: { source_video: videos[0], control_video: videos[0], pose_video: videos[1], drive_video: videos[1] },
    audios: { audio: audios[0], speech: audios[0], bgm: audios[1], voice: audios[0] },
    imageList: images, videoList: videos, audioList: audios, refImages: images, maskImage: images[2], maskImage: images[2],
    // 拼接工作流（WF-16）与配音工作流（WF-26）都要用：每段的真实尺寸 / 帧率 / 有没有音轨。
    // 第 1 段「带音轨」用来让 WF-26 把 AudioMerge 混音分支也装配出来（自检覆盖全图），
    // 同时 WF-16 的直通分支（尺寸帧率一致）依然被第 1 段覆盖到。
    // 第 1 段与目标规格一致（走直通），第 2 段尺寸和帧率都不同（走抽帧+缩放归一化），
    // 两条分支都能被自检覆盖到（含 VideoFrameSample / ImageScale / CreateVideo 三个节点）
    videoMeta: videos.map((f, i) => (i === 0
      ? { assetId: null, file: f, width: 720, height: 1280, frames: 65, durationMs: 4063, fps: 16, hasAudio: true }
      : { assetId: null, file: f, width: 760, height: 1280, frames: 100, durationMs: 4167, fps: 24, hasAudio: false })),
    aspectGenSize: { width: 720, height: 1280 },
  };
}

/**
 * 展开 COMFY_AUTOGROW_V3 的输入名。实机 comfy_api/latest/_io.py 里
 * `expected_id = finalize_prefix(curr_prefix, name)`，而 curr_prefix 就是分组名，
 * 所以最终名是「<分组名>.<前缀><下标>」，例如 ConcatenateVideo → videos.video0，
 * MiniMaxH3ReferenceToVideo → ref_images.ref_image_0 / ref_videos.ref_video_0 …
 */
function autogrowNames(groupKey, spec) {
  const t = spec?.[1]?.template;
  if (!t) return [];
  const wrap = (n) => (groupKey ? `${groupKey}.${n}` : n);
  if (Array.isArray(t.names)) return t.names.map(wrap);
  if (typeof t.prefix === "string") {
    const max = Number(t.max ?? 10);
    return Array.from({ length: max }, (_, i) => wrap(`${t.prefix}${i}`));
  }
  return [];
}

/**
 * 展开 COMFY_DYNAMICCOMBO_V3 各分支里的子输入名，并还原成提交时的扁平名
 * （如 TextGenerate.sampling_mode → sampling_mode.temperature / sampling_mode.top_k …）。
 */
function dynamicComboNames(groupKey, spec) {
  const out = [];
  const walk = (prefix, opts) => {
    for (const o of opts || []) {
      const ins = o?.inputs;
      if (!ins || typeof ins !== "object") continue;
      for (const sec of ["required", "optional"]) {
        for (const [k, v] of Object.entries(ins[sec] || {})) {
          const name = `${prefix}.${k}`;
          out.push(name);
          if (Array.isArray(v) && v[0] === "COMFY_DYNAMICCOMBO_V3") walk(name, v[1]?.options);
        }
      }
    }
  };
  const opts = spec?.[1]?.options;
  if (Array.isArray(opts) && opts.some((o) => o && typeof o === "object" && "inputs" in o)) walk(groupKey, opts);
  return out;
}

/**
 * COMFY_DYNAMICCOMBO_V3 的分支子输入在提交给 /prompt 时会被**扁平化**为
 * `<分组名>.<子输入名>`（实机报错原文：input_name="sampling_mode.top_p"）。
 * 这里按当前选中的分支核对必填子输入是否都给了，避免"自检通过、点了就 400"。
 */
function missingDynamicInputs(nodeId, classType, def, inputs) {
  const problems = [];
  for (const [key, spec] of Object.entries(def.input?.required || {})) {
    if (!Array.isArray(spec) || typeof spec[0] !== "string" || !spec[0].startsWith("COMFY_DYNAMICCOMBO")) continue;
    const selected = inputs?.[key];
    if (typeof selected !== "string") continue;
    const branch = (spec[1]?.options || []).find((o) => o && o.key === selected);
    if (!branch?.inputs) continue;
    for (const sub of Object.keys(branch.inputs.required || {})) {
      const name = `${key}.${sub}`;
      if (!(name in inputs)) {
        problems.push({
          type: "INPUT_ABSENT", node: nodeId, class_type: classType, key: name,
          message: `动态分组 ${key}="${selected}" 缺少必填子输入 ${name}`,
        });
      }
    }
  }
  return problems;
}

/** 上传驱动的 COMBO（LoadImage/LoadVideo/LoadAudio/LoadImageMask）选项随 input 目录变化，跳过枚举校验 */
const isUploadCombo = (spec) => !!(spec?.[1]?.image_upload || spec?.[1]?.video_upload || spec?.[1]?.audio_upload);

/**
 * 取出「纯字符串枚举」输入的可选值；不是这种形状就返回 null，交给别的检查处理。
 * 实机三种形状必须分清：
 *   ["a.safetensors","b.safetensors"]                       老式 COMBO（VAELoader / UNETLoader / CLIPLoader…）
 *   ["COMBO", { options: ["a.safetensors", …] }]            新式 COMBO（LTXVAudioVAELoader.ckpt_name 等 io.Schema 节点）
 *   ["COMFY_DYNAMICCOMBO_V3", { options: [{key, inputs}] }] 动态分组，选项是对象不是字符串，不走这里
 *    （它的分支子输入由 dynamicComboNames() / missingDynamicInputs() 负责）
 * 只认老式会漏掉新式，于是「自检显示可用、一点就 400」——LTX-2.5 的音频 VAE 就是这么漏掉的
 * （实机报错原文：节点4(LTXVAudioVAELoader) Value not in list：ckpt_name: 'ltx-2.5-audio-vae-bf16.safetensors'）。
 */
function comboOptions(spec) {
  if (!Array.isArray(spec)) return null;
  let opts = null;
  if (Array.isArray(spec[0])) opts = spec[0];
  else if (spec[0] === "COMBO") opts = spec[1]?.options;
  if (!Array.isArray(opts) || !opts.length) return null;
  return typeof opts[0] === "string" ? opts : null;
}

/** 逐字段核对工作流与实机 /object_info */
function validateWorkflow(workflow, oi) {
  const problems = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    const def = oi[node.class_type];
    if (!def) {
      problems.push({ type: "NODE_MISSING", node: nodeId, class_type: node.class_type, message: `节点 ${node.class_type} 在当前 ComfyUI 上不存在` });
      continue;
    }
    const required = def.input?.required || {};
    const optional = def.input?.optional || {};
    const spec = { ...required, ...optional };
    const extra = {};
    for (const [k, s] of Object.entries({ ...required, ...optional })) {
      for (const n of autogrowNames(k, s)) extra[n] = ["IMAGE", {}];
      for (const n of dynamicComboNames(k, s)) extra[n] = ["STRING", {}];
    }
    const all = { ...spec, ...extra };
    problems.push(...missingDynamicInputs(nodeId, node.class_type, def, node.inputs || {}));
    for (const [key, val] of Object.entries(node.inputs || {})) {
      const s = all[key];
      if (!s) { problems.push({ type: "INPUT_UNKNOWN", node: nodeId, class_type: node.class_type, message: `输入 ${key} 不属于 ${node.class_type}` }); continue; }
      if (isUploadCombo(s)) continue;
      const opts = comboOptions(s);
      if (opts && opts.length && typeof val === "string" && !opts.includes(val)) {
        problems.push({
          type: "MODEL_MISSING", node: nodeId, class_type: node.class_type, key, value: val,
          message: `${node.class_type}.${key}="${val}" 不在可选列表中`,
          optionsSample: opts.slice(0, 8),
        });
      }
    }
    for (const key of Object.keys(required)) {
      const spec = required[key];
      // COMFY_AUTOGROW_V3 不提交分组名本身，而是提交 <前缀><下标>（如 video0/video1）
      if (Array.isArray(spec) && typeof spec[0] === "string" && spec[0].startsWith("COMFY_AUTOGROW")) {
        const names = autogrowNames(key, spec);
        const given = names.filter((n) => n in (node.inputs || {}));
        const min = Number(spec[1]?.template?.min ?? 1);
        if (given.length < min) {
          problems.push({
            type: "INPUT_ABSENT", node: nodeId, class_type: node.class_type, key,
            message: `自动增长输入 ${key} 至少需要 ${min} 项（前缀 ${spec[1]?.template?.prefix || "?"}）`,
          });
        }
        continue;
      }
      // 注意：/object_info 里带 default 的"必填"输入，走 API 提交时 ComfyUI 仍会判为缺失
      // （实测 WanContextWindowsManual.split_conds_to_windows，schema 有 default:false 但提交必须给）。
      // 所以这里保持严格：required 里有、我们没给，就报错。
      if (!(key in (node.inputs || {}))) {
        problems.push({ type: "INPUT_ABSENT", node: nodeId, class_type: node.class_type, message: `缺少必填输入 ${key}` });
      }
    }
  }
  return problems;
}

/**
 * 提交前归一化：COMFY_DYNAMICCOMBO_V3 的分支子输入必须用扁平名给出。
 * SaveVideo.format="auto" 时实机强制要求 format.codec，这里统一补齐，
 * 避免每个工作流各写一遍。
 */
function normalizeBuiltWorkflow(built) {
  for (const node of Object.values(built || {})) {
    const inputs = node?.inputs;
    if (!inputs) continue;
    if (node.class_type === "SaveVideo" && typeof inputs.format === "string" && !("format.codec" in inputs)) {
      inputs["format.codec"] = typeof inputs.codec === "string" ? inputs.codec : "auto";
    }
  }
  return built;
}

const HARD = new Set(["NODE_MISSING", "INPUT_UNKNOWN", "MODEL_MISSING", "INPUT_ABSENT"]);

/**
 * 把 int8/convrot 的 VAE 换成 fp16 版本。
 * 老驱动（实测 550.163.01）跑不了 comfy_kitchen 的 int8 attention kernel，
 * MiniMax-H3 的 int8 视频 VAE 解码会直接 "kernel launch failed"；换 fp16 即可绕过。
 */
function swapToFp16Vae(built) {
  for (const node of Object.values(built || {})) {
    const name = node?.inputs?.vae_name;
    if (typeof name === "string" && /int8|convrot/i.test(name) && M.mmVaeFp16) {
      node.inputs.vae_name = M.mmVaeFp16;
    }
  }
  return built;
}

/** 该装配结果里是否用了 int8/convrot 的 VAE（用于决定要不要触发降级重试） */
function usesInt8Vae(built) {
  return Object.values(built || {}).some((n) => typeof n?.inputs?.vae_name === "string" && /int8|convrot/i.test(n.inputs.vae_name));
}

let cache = { at: 0, data: null };

async function checkCapabilities(pool, { force = false } = {}) {
  if (!force && cache.data && (Date.now() - cache.at) / 1000 < config.comfy.objectInfoCacheSeconds) return cache.data;
  const instances = pool ? await pool.anyOnline() : [];
  // 能力自检的默认探针实例：通用实例（222 上的那几台）。
  // 本机那台是「翻唱专用」（RVC / Demucs / ACE-Step 权重只在它上面），
  // 拿它去核对通用工作流只会得到一片假红，所以这里先排除掉。
  const shared = instances.filter((i) => !i.local);
  const inst = shared[0] || instances[0]
    || pool?.instances?.find((i) => !i.local) || pool?.instances?.[0] || null;
  if (!inst) {
    return { checkedAt: new Date().toISOString(), online: false, workflows: [], missing: [{ type: "OFFLINE", message: "没有可用的 ComfyUI 实例" }] };
  }
  let oi = null;
  try { oi = await inst.getObjectInfo(true); } catch (err) {
    return { checkedAt: new Date().toISOString(), online: false, workflows: [], missing: [{ type: "OFFLINE", message: `无法读取 /object_info：${err.message}` }] };
  }

  const missing = [];
  const list = [];
  for (const wf of Object.values(workflows)) {
    const entry = {
      id: wf.id, label: wf.label, kind: wf.kind, engine: wf.engine, mode: wf.mode || null,
      fps: wf.fps ?? null, hasAudio: !!wf.hasAudio, sizeStep: wf.sizeStep || 16,
      vramClass: wf.vramClass, vramNeedMB: wf.vramNeedMB || 0,
      maxDurationS: wf.maxDurationS ?? null,
      supports: wf.supports || {}, defaults: wf.defaults || {}, local: !!wf.localOnly,
      cameraPoses: wf.cameraPoses || null,
      systemPrompts: wf.systemPrompts ? Object.keys(wf.systemPrompts) : null,
      available: true, reasons: [],
    };
    if (wf.instances?.length) entry.instances = wf.instances;
    if (wf.machine) entry.machine = wf.machine;
    if (wf.unavailableReason) { entry.available = false; entry.reasons.push(wf.unavailableReason); }
    // 本机处理的工作流（如 WF-26 配音合成）不装配 ComfyUI 图，也就没有「缺模型」这一说
    if (wf.localOnly) {
      entry.reasons.push(wf.localNote || "本机处理：不经过 ComfyUI，不占用 222 的显存");
      list.push(entry);
      continue;
    }
    // 专用实例的工作流（本机翻唱：RVC / Demucs / ACE-Step）：拿那台机器的
    // /object_info 核对，而不是 222 的 —— 两边的权重完全不是一回事。
    let oiWf = oi;
    if (wf.instances?.length) {
      const target = pool?.instances?.find((i) => i.id === wf.instances[0]) || null;
      if (!target || !target.enabled || !target.online) {
        entry.available = false;
        entry.reasons.push(`专用实例 ${wf.instances[0]}（${wf.machine || "本机"}）当前不在线`);
        list.push(entry);
        continue;
      }
      try { oiWf = await target.getObjectInfo(); } catch (error) {
        entry.available = false;
        entry.reasons.push(`无法读取 ${wf.instances[0]} 的 /object_info：${error.message}`);
        list.push(entry);
        continue;
      }
    }
    try {
      const built = normalizeBuiltWorkflow(wf.build(probeContext(wf)));
      const problems = validateWorkflow(built, oiWf).filter((p) => HARD.has(p.type));

      if (problems.length) {
        entry.available = false;
        const names = [...new Set(problems.map((p) => p.value).filter(Boolean))];
        entry.reasons.push(`装配校验未通过：${problems.slice(0, 3).map((p) => p.message).join("；")}${problems.length > 3 ? ` 等 ${problems.length} 项` : ""}`);
        if (names.length) entry.missingModels = names;
        for (const p of problems.slice(0, 10)) missing.push({ wf: wf.id, ...p });
      }
    } catch (err) {
      entry.available = false;
      entry.reasons.push(`装配失败：${err.message}`);
    }
    list.push(entry);
  }

  const data = {
    checkedAt: new Date().toISOString(),
    online: true,
    objectInfoNodes: Object.keys(oi).length,
    workflows: list,
    missing,
    models: M,
  };
  cache = { at: Date.now(), data };
  const bad = list.filter((w) => !w.available).length;
  log.info(`能力自检完成：${list.length} 个工作流，${bad} 个不可用`);
  return data;
}

function getWorkflow(id) { return workflows[id] || null; }
function allWorkflows() { return workflows; }

module.exports = {
  workflows, getWorkflow, allWorkflows, checkCapabilities, validateWorkflow,
  probeContext, autogrowNames, normalizeBuiltWorkflow,
  swapToFp16Vae, usesInt8Vae, comboOptions,
};
