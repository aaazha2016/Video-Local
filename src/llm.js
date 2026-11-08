"use strict";
/**
 * 本地 LLM 目录（故事创作的文案 / 分镜拆解用）。
 *
 * 全部走 192.168.0.222 上的 ComfyUI：CLIPLoader(text_encoders) → TextGenerate。
 * 结论来自 2026-09-29 在实机逐条试跑（见 note 字段），不是猜测：
 *
 *   qwen_3_4b            + ltxv       → 可用，输出合法 JSON（默认）
 *   gemma4-12b-...-ltx   + ltxv       → 能跑但输出乱码（LTX-AV 专用模板，非通用对话）
 *   qwen3vl_32b_minimax  + minimax    → 加载即报 CUDA 驱动版本不足；且 bf16 需 64GB > 单卡 48GB
 *   qwen_2.5_vl_7b       + qwen_image → 该路径未实现文本生成（缺 stop_tokens）
 *
 * 新增可用模型后无需改代码：把权重放进 text_encoders，在 CATALOG 里补一条即可，
 * 可用性由 checkLlms() 对着实机 CLIPLoader 选项自动判定。
 */

const external = require("./llm-external");

/** 采样预设：给分镜/文案不同的创作风格 */
const PRESETS = {
  fast: { label: "极速（低延迟）", max_length: 700, temperature: 0.6, top_p: 0.9, repetition_penalty: 1.1 },
  balanced: { label: "均衡（默认）", max_length: 900, temperature: 0.7, top_p: 0.95, repetition_penalty: 1.15 },
  creative: { label: "创意发散", max_length: 1100, temperature: 0.95, top_p: 0.98, repetition_penalty: 1.2 },
  precise: { label: "严谨复刻", max_length: 900, temperature: 0.35, top_p: 0.85, repetition_penalty: 1.05 },
};

const CATALOG = [
  {
    id: "qwen3-4b",
    label: "Qwen3-4B（推荐）",
    file: "qwen_3_4b.safetensors",
    clipType: "ltxv",
    vramMB: 16000,
    chatCapable: true,
    verified: true,
    note: "本机实测可稳定输出结构化 JSON，速度快，适合批量拆分镜",
    defaults: { temperature: 0.7, top_k: 64, top_p: 0.95, min_p: 0.05, repetition_penalty: 1.15, max_length: 900 },
  },
  {
    id: "gemma4-12b",
    label: "Gemma4-12B（LTX-2.5 文本编码器）",
    file: "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
    clipType: "ltxv",
    vramMB: 24000,
    chatCapable: false,
    verified: false,
    note: "该权重是 LTX-2.5 的视频提示词编码器，走通用对话模板会输出乱码，不适合写文案/分镜",
    defaults: { temperature: 0.7, top_k: 64, top_p: 0.95, min_p: 0.05, repetition_penalty: 1.05, max_length: 900 },
  },
  {
    id: "qwen3vl-32b",
    label: "Qwen3-VL-32B（MiniMax-H3 文本编码器）",
    file: "qwen3vl_32b_minimax_h3_bf16.safetensors",
    clipType: "minimax",
    vramMB: 64000,
    chatCapable: false,
    verified: false,
    note: "32B bf16 约 64GB，单张 A6000 48GB 放不下；int8 版本又需要更新的显卡驱动",
    defaults: { temperature: 0.7, top_k: 64, top_p: 0.95, min_p: 0.05, repetition_penalty: 1.05, max_length: 900 },
  },
  {
    id: "qwen25-vl-7b",
    label: "Qwen2.5-VL-7B",
    file: "qwen_2.5_vl_7b.safetensors",
    clipType: "qwen_image",
    vramMB: 15000,
    chatCapable: false,
    verified: false,
    note: "ComfyUI 走 qwen_image 路径加载该权重时不提供文本生成接口（缺 stop_tokens），无法用于对话",
    defaults: { temperature: 0.7, top_k: 64, top_p: 0.95, min_p: 0.05, repetition_penalty: 1.05, max_length: 900 },
  },
];

const DEFAULT_LLM = "qwen3-4b";

function getLlm(id) { return CATALOG.find((m) => m.id === id) || null; }

/**
 * 对着实机校验每个 LLM 是否真的可用。
 * 判定条件：① 权重出现在该实例 CLIPLoader 的 clip_name 选项里；② 该模型本身支持对话生成。
 */
async function checkLlms(pool) {
  // 本机那台是「翻唱专用」（RVC / Demucs / ACE-Step），没有 222 上的 Qwen 文本编码器，
  // 拿它当探针会把本地 LLM 全判成不可用，所以先排除掉。
  const list = pool.online().filter((i) => !i.local);
  const inst = list[0] || pool.instances.find((i) => i.enabled && !i.local) || pool.online()[0] || null;

  let availableFiles = null;
  let probeError = null;
  if (inst) {
    try {
      const oi = await inst.getObjectInfo();
      availableFiles = new Set(oi?.CLIPLoader?.input?.required?.clip_name?.[0] || []);
    } catch (err) { probeError = err.message; }
  }

  const models = CATALOG.map((m) => {
    const reasons = [];
    if (availableFiles && !availableFiles.has(m.file)) reasons.push(`权重 ${m.file} 不在本机 text_encoders 里`);
    if (!m.chatCapable) reasons.push(m.note);
    if (probeError) reasons.push(`无法读取实机节点定义：${probeError}`);
    const available = reasons.length === 0;
    return {
      id: m.id, label: m.label, file: m.file, clip_type: m.clipType, vram_mb: m.vramMB,
      available, verified: !!m.verified, note: m.note, defaults: m.defaults,
      reasons: available ? [] : reasons,
    };
  });

  // 外部商业模型：与本地模型并列，由用户在网页上自行配置
  const extModels = external.listModels();
  const merged = [...models, ...extModels];

  return {
    checkedAt: new Date().toISOString(),
    default: DEFAULT_LLM,
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, ...p })),
    models: merged,
    groups: [
      { id: "local", label: "本地模型（192.168.0.222 · 免费、不出网）", model_ids: models.map((m) => m.id) },
      { id: "external", label: "外部商业模型（走公网 · 按量计费）", model_ids: extModels.map((m) => m.id) },
    ],
    available: merged.filter((m) => m.available).map((m) => m.id),
    external: {
      configured: extModels.length > 0,
      presets: external.PRESETS,
      connectors: external.listPublic(),
    },
  };
}

/**
 * 把 UI 传入的选择解析成 WF-24 的构建参数。
 * @returns {{llmId:string, params:object, error?:string}}
 */
function resolveLlmParams(body = {}) {
  const llmId = body.llm || body.llm_id || DEFAULT_LLM;
  const model = getLlm(llmId);
  if (!model) return { error: `未知的 LLM：${llmId}（可选：${CATALOG.map((m) => m.id).join(", ")}）` };
  if (!model.chatCapable) return { error: `模型「${model.label}」不支持本地对话生成：${model.note}` };

  const preset = PRESETS[body.preset] || null;
  const base = { ...model.defaults, ...(preset ? { max_length: preset.max_length, temperature: preset.temperature, top_p: preset.top_p, repetition_penalty: preset.repetition_penalty } : {}) };
  const pick = (k) => (body[k] === undefined || body[k] === null || body[k] === "" ? base[k] : Number(body[k]));

  return {
    llmId,
    params: {
      llm: llmId,
      llm_file: model.file,
      llm_clip_type: model.clipType,
      max_length: Math.min(4096, Math.max(64, Math.round(pick("max_length")))),
      temperature: pick("temperature"),
      top_k: Math.round(pick("top_k")),
      top_p: pick("top_p"),
      min_p: pick("min_p"),
      repetition_penalty: pick("repetition_penalty"),
      thinking: body.thinking === true || body.thinking === "true" || body.thinking === 1,
    },
  };
}


/**
 * 统一解析「用哪个模型」：既支持本地 ComfyUI 模型，也支持外部商业模型。
 *
 * 外部模型的 id 形如 ext:conn_ab12cd34:deepseek-chat（见 src/llm-external.js）。
 *
 * @returns {{transport:"local"|"external", llmId:string, label:string, params:object, connector?:object, model?:string, error?:string}}
 */
function resolveLlmSelection(body = {}) {
  const requested = body.llm || body.llm_id || null;
  const preset = PRESETS[body.preset] || PRESETS.balanced;

  const extRef = external.parseExternalId(requested);
  if (extRef) {
    const c = external.getConnector(extRef.connectorId);
    if (!c) return { error: `外部连接器不存在：${extRef.connectorId}（可能已被删除，请刷新页面后重选）` };
    if (c.enabled === false) return { error: `连接器「${c.label}」已停用` };
    if (!extRef.model) return { error: `连接器「${c.label}」还没有选择模型` };
    if (!c.apiKey) return { error: `连接器「${c.label}」未配置 API Key` };
    return {
      transport: "external",
      llmId: requested,
      label: `${c.label} · ${extRef.model}`,
      connector: c,
      model: extRef.model,
      params: { temperature: preset.temperature, top_p: preset.top_p, max_length: preset.max_length },
    };
  }

  const llmId = requested || DEFAULT_LLM;
  const model = getLlm(llmId);
  if (!model) {
    return { error: `未知的 LLM：${llmId}（本地可选：${CATALOG.map((m) => m.id).join(", ")}；外部模型 id 形如 ext:conn_xxxx:模型名）` };
  }
  if (!model.chatCapable) return { error: `模型「${model.label}」不支持本地对话生成：${model.note}` };

  const base = {
    ...model.defaults,
    ...(body.preset && PRESETS[body.preset]
      ? { max_length: preset.max_length, temperature: preset.temperature, top_p: preset.top_p, repetition_penalty: preset.repetition_penalty }
      : {}),
  };
  const pick = (k) => (body[k] === undefined || body[k] === null || body[k] === "" ? base[k] : Number(body[k]));

  return {
    transport: "local",
    llmId,
    label: model.label,
    params: {
      llm: llmId,
      llm_file: model.file,
      llm_clip_type: model.clipType,
      max_length: Math.min(4096, Math.max(64, Math.round(pick("max_length")))),
      temperature: pick("temperature"),
      top_k: Math.round(pick("top_k")),
      top_p: pick("top_p"),
      min_p: pick("min_p"),
      repetition_penalty: pick("repetition_penalty"),
      thinking: body.thinking === true || body.thinking === "true" || body.thinking === 1,
    },
  };
}

module.exports = {
  CATALOG, PRESETS, DEFAULT_LLM, getLlm, checkLlms,
  resolveLlmParams, resolveLlmSelection,
};
