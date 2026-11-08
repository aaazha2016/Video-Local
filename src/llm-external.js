"use strict";
/**
 * 外部商业大模型（第三方 API）接入。
 *
 * 与 src/llm.js 的本地模型并列，是「故事创作 / 提示词扩写」的另一种可选后端。
 * 默认不配置、不启用：只有用户在网页上显式添加连接器并选中它时，提示词才会发往外部服务。
 *
 * 连接器（connector）= 一条外部模型通道，落盘在 data/external-llm.json：
 *   { id, label, preset, baseUrl, kind, apiKey, model, enabled, lastTest, createdAt, updatedAt }
 *
 * 绝大多数厂商都提供 OpenAI 兼容的 POST /chat/completions，所以 kind 默认 "openai"；
 * Anthropic 走原生 messages 协议，kind = "anthropic"。
 * 模型名一律不写死在代码里 —— 通过 POST /api/llm/providers/test 调各家的 GET /models 实时拉取。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("./config");
const log = require("./logger").scope("llm-ext");

const STORE_FILE = path.join(config.paths.data, "external-llm.json");
const DEFAULT_TIMEOUT_MS = 120000;

/** 常见厂商预设。baseUrl 只是默认值，界面上可以随时改。 */
const PRESETS = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", kind: "openai", note: "官方接口，通常需要海外网络" },
  { id: "deepseek", label: "DeepSeek 深度求索", baseUrl: "https://api.deepseek.com/v1", kind: "openai", note: "国内直连" },
  { id: "dashscope", label: "阿里云百炼（通义千问）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", kind: "openai", note: "国内直连" },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", kind: "openai", note: "国内直连" },
  { id: "moonshot", label: "月之暗面 Kimi", baseUrl: "https://api.moonshot.cn/v1", kind: "openai", note: "国内直连" },
  { id: "siliconflow", label: "硅基流动 SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", kind: "openai", note: "聚合多家开源模型" },
  { id: "volcengine", label: "火山方舟（豆包）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", kind: "openai", note: "国内直连" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", kind: "openai", note: "聚合网关，需要海外网络" },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", kind: "openai", note: "官方 OpenAI 兼容端点，需要海外网络" },
  { id: "anthropic", label: "Anthropic Claude", baseUrl: "https://api.anthropic.com/v1", kind: "anthropic", note: "原生 messages 协议" },
  { id: "custom", label: "自定义（OpenAI 兼容）", baseUrl: "", kind: "openai", note: "任何 OpenAI 兼容网关，例如 one-api / new-api" },
];

const getPreset = (id) => PRESETS.find((p) => p.id === id) || null;

// ------------------------------------------------------------------ 落盘
function loadAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return { version: 1, connectors: Array.isArray(raw && raw.connectors) ? raw.connectors : [] };
  } catch (e) {
    if (e.code !== "ENOENT") log.warn(`读取 ${STORE_FILE} 失败：${e.message}`);
    return { version: 1, connectors: [] };
  }
}

function saveAll(data) {
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
  try { fs.chmodSync(STORE_FILE, 0o600); } catch { /* Windows 上无此语义，忽略 */ }
}

const newConnectorId = () => `conn_${crypto.randomBytes(5).toString("hex")}`;

/** 只露出首尾，中间打码；绝不把完整 Key 回传给前端 */
function maskKey(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}${"*".repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`;
}

function publicConnector(c) {
  return {
    id: c.id, label: c.label, preset: c.preset, base_url: c.baseUrl, kind: c.kind || "openai",
    model: c.model || "", enabled: c.enabled !== false,
    has_key: !!c.apiKey, api_key_masked: maskKey(c.apiKey),
    last_test: c.lastTest || null,
    created_at: c.createdAt || null, updated_at: c.updatedAt || null,
  };
}

const listPublic = () => loadAll().connectors.map(publicConnector);
const listAll = () => loadAll().connectors;
const getConnector = (id) => loadAll().connectors.find((c) => c.id === id) || null;

// ------------------------------------------------------- 模型 id 编解码
/** 形如 ext:conn_ab12cd34:deepseek-chat；连接器 id 为固定格式，故前两段冒号可安全切分 */
function buildExternalId(connectorId, model) { return `ext:${connectorId}:${model}`; }

function parseExternalId(id) {
  const s = String(id || "");
  if (!s.startsWith("ext:")) return null;
  const rest = s.slice(4);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  return { connectorId: rest.slice(0, i), model: rest.slice(i + 1) };
}

// -------------------------------------------------------------- 校验 / CRUD
function normalize(body, base = {}) {
  const preset = getPreset(body.preset) || getPreset(base.preset) || getPreset("custom");
  const out = {
    id: base.id || newConnectorId(),
    label: String(body.label ?? base.label ?? preset.label).trim() || preset.label,
    preset: preset.id,
    baseUrl: String(body.base_url ?? body.baseUrl ?? base.baseUrl ?? preset.baseUrl ?? "").trim().replace(/\/+$/, ""),
    kind: (body.kind ?? base.kind ?? preset.kind) === "anthropic" ? "anthropic" : "openai",
    apiKey: String(body.api_key ?? body.apiKey ?? base.apiKey ?? "").trim(),
    model: String(body.model ?? base.model ?? "").trim(),
    enabled: (body.enabled ?? base.enabled) !== false,
    lastTest: body.lastTest ?? base.lastTest ?? null,
    createdAt: base.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return out;
}

function validate(c) {
  const problems = [];
  if (!c.baseUrl) problems.push("接口地址不能为空");
  if (c.baseUrl && !/^https?:\/\//i.test(c.baseUrl)) problems.push("接口地址必须以 http:// 或 https:// 开头");
  return problems;
}

function createConnector(body = {}) {
  const data = loadAll();
  const c = normalize(body);
  const problems = validate(c);
  if (problems.length) return { error: problems.join("；") };
  if (!body.api_key && !body.apiKey) c.apiKey = "";
  data.connectors.push(c);
  saveAll(data);
  return { connector: publicConnector(c) };
}

function updateConnector(id, body = {}) {
  const data = loadAll();
  const idx = data.connectors.findIndex((x) => x.id === id);
  if (idx < 0) return { error: "连接器不存在", missing: true };
  const prev = data.connectors[idx];
  const c = normalize(body, prev);
  // 前端回传的是打码值或空值时，保留原 Key（避免把 **** 存成真 Key）
  const incoming = body.api_key ?? body.apiKey;
  if (incoming === undefined || incoming === null || incoming === "" || incoming === maskKey(prev.apiKey)) {
    c.apiKey = prev.apiKey;
  }
  const problems = validate(c);
  if (problems.length) return { error: problems.join("；") };
  data.connectors[idx] = c;
  saveAll(data);
  return { connector: publicConnector(c) };
}

function removeConnector(id) {
  const data = loadAll();
  const next = data.connectors.filter((x) => x.id !== id);
  if (next.length === data.connectors.length) return { missing: true };
  data.connectors = next;
  saveAll(data);
  return { ok: true };
}

function recordTest(id, result) {
  const data = loadAll();
  const c = data.connectors.find((x) => x.id === id);
  if (!c) return;
  c.lastTest = { ok: !!result.ok, at: new Date().toISOString(), error: result.ok ? null : String(result.error || "") };
  c.updatedAt = c.lastTest.at;
  saveAll(data);
}

// ------------------------------------------------------------ 供选择器使用
function listModels() {
  return listAll().map((c) => {
    const reasons = [];
    if (c.enabled === false) reasons.push("连接器已停用");
    if (!c.baseUrl) reasons.push("未填写接口地址");
    if (!c.apiKey) reasons.push("未填写 API Key");
    if (!c.model) reasons.push("未选择模型");
    const available = reasons.length === 0;
    const failed = c.lastTest && c.lastTest.ok === false;
    return {
      id: buildExternalId(c.id, c.model || ""),
      label: `${c.label} · ${c.model || "（未选模型）"}`,
      source: "external",
      provider: c.label,
      preset: c.preset,
      kind: c.kind || "openai",
      base_url: c.baseUrl,
      connector_id: c.id,
      model: c.model || "",
      available,
      reasons: available ? [] : reasons,
      note: failed
        ? `上次连通性测试失败：${c.lastTest.error}`
        : "外部商业模型：提示词会发送到第三方服务，按量计费",
      last_test: c.lastTest || null,
    };
  });
}

// ------------------------------------------------------------ HTTP 调用
function authHeaders(c) {
  const h = { "content-type": "application/json" };
  if ((c.kind || "openai") === "anthropic") {
    h["x-api-key"] = c.apiKey;
    h["anthropic-version"] = "2023-06-01";
  } else {
    h.authorization = `Bearer ${c.apiKey}`;
  }
  return h;
}

function describeHttp(status, bodyText, c) {
  const snippet = String(bodyText || "").replace(/\s+/g, " ").slice(0, 220);
  if (status === 401 || status === 403) return `${c.label} 鉴权失败（HTTP ${status}）：API Key 无效或没有该模型权限。${snippet}`;
  if (status === 404) return `${c.label} 找不到接口（HTTP 404）：请检查「接口地址」是否填对（应包含 /v1 之类的版本段）。${snippet}`;
  if (status === 429) return `${c.label} 触发限流（HTTP 429）：请稍后重试或检查配额。${snippet}`;
  if (status >= 500) return `${c.label} 服务端错误（HTTP ${status}）：${snippet}`;
  return `${c.label} 返回错误（HTTP ${status}）：${snippet}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 把网络层异常翻译成人能看懂的话 */
function wrapNetworkError(e, c, timeoutMs) {
  if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) {
    return Object.assign(new Error(`${c.label} 请求超时（超过 ${Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)} 秒无响应）`), { code: "LLM_TIMEOUT" });
  }
  const cause = e && e.cause ? e.cause.code || e.cause.message : "";
  return Object.assign(
    new Error(`${c.label} 无法连接：${e.message}${cause ? `（${cause}）` : ""}。若在国内访问海外厂商，请确认网络可达。`),
    { code: "LLM_NETWORK" }
  );
}

/**
 * token 上限：外部模型里有不少是「推理模型」，思考过程同样算 max_tokens，
 * 900 这种按本地小模型定的上限会被一次思考吃光（详见 chat 里的说明），所以给足下限。
 * 注意 max_tokens 只是**上限、不是计费额** —— 模型提前写完就提前停，调大不会多花钱。
 */
const MIN_MAX_TOKENS = 4096;
const MAX_MAX_TOKENS = 32000;
/** 被截断时一次至少放大到这么多，之后每次翻倍；最多放大 MAX_ESCALATIONS 次，避免模型写不完时无限重试烧钱 */
const MIN_RETRY_TOKENS = 8192;
const MAX_ESCALATIONS = 4;

/**
 * 把返回里的**正文**抠出来。
 *
 * 兼容三种形态：`content` 字符串、`content` 分块数组（部分网关 / 多模态）、老 completions 的 `choices[0].text`。
 *
 * 注意：**不能拿 `reasoning_content` 当正文**。那是模型的思考草稿（实测会写一大段「也许反转是…」的自我辩论），
 * 正文为空时正确做法是放大 token 上限重试（见 chat），而不是把草稿当结果返回。
 */
function extractText(json, kind) {
  if (kind === "anthropic") {
    return Array.isArray(json?.content)
      ? json.content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("")
      : "";
  }
  const choice = (json?.choices || [])[0] || {};
  const content = choice.message ? choice.message.content : null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((b) => b && (b.type === "text" || b.type === "output_text"))
      .map((b) => b.text || "");
    if (parts.length) return parts.join("");
  }
  return typeof choice.text === "string" ? choice.text : "";
}

/**
 * 调用外部模型，返回纯文本。
 * 网络异常 / 鉴权失败都会抛带有可读 message 的 Error，便于直接展示给用户。
 */
async function chat(connector, opts = {}) {
  const c = connector || {};
  const base = String(c.baseUrl || "").replace(/\/+$/, "");
  if (!base) throw Object.assign(new Error("连接器未配置接口地址"), { code: "LLM_CONFIG" });
  if (!c.apiKey) throw Object.assign(new Error(`连接器「${c.label || c.id}」未配置 API Key`), { code: "LLM_CONFIG" });
  const model = opts.model || c.model;
  if (!model) throw Object.assign(new Error("未指定模型名"), { code: "LLM_CONFIG" });

  const kind = (c.kind || "openai") === "anthropic" ? "anthropic" : "openai";
  const url = kind === "anthropic" ? `${base}/messages` : `${base}/chat/completions`;
  const temperature = Number.isFinite(opts.temperature) ? Number(opts.temperature) : 0.7;
  // 调用方给的 maxTokens（往往继承本地模型的 max_length，例如 900）只作为「期望正文长度」参考，
  // 实际下限抬到 MIN_MAX_TOKENS：推理模型的思考 token 也记在 max_tokens 里，
  // 上限太小会出现「思考写完、正文一个字都没写」的 finish_reason=length（用户看到的就是「没有返回文本内容」）。
  const maxTokens = Math.max(MIN_MAX_TOKENS, Math.min(MAX_MAX_TOKENS, Number(opts.maxTokens) || MIN_MAX_TOKENS));
  const system = opts.system ? String(opts.system) : "";
  const user = String(opts.user || "");
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const buildBody = (budget) => (kind === "anthropic"
    ? { model, max_tokens: budget, temperature, ...(system ? { system } : {}), messages: [{ role: "user", content: user }] }
    : {
        model,
        messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }],
        temperature, max_tokens: budget, stream: false,
      });

  let budget = maxTokens;
  // 「正文被截断」「只写了思考」两种情况都靠放大 token 上限重试来救：
  // 智能体 / 推理模型会把上限花在思考上，分镜这种长 JSON 又常常写到一半就顶到上限。
  let escalations = 0;
  const growBudget = (why) => {
    if (escalations >= MAX_ESCALATIONS || budget >= MAX_MAX_TOKENS) return 0;
    const next = Math.min(MAX_MAX_TOKENS, Math.max(budget * 2, MIN_RETRY_TOKENS));
    if (next <= budget) return 0;
    escalations += 1;
    budget = next;
    log.warn(`${c.label} ${why}，把 token 上限放大到 ${next} 重试（第 ${escalations} 次）`);
    return next;
  };
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetchWithTimeout(url, { method: "POST", headers: authHeaders(c), body: JSON.stringify(buildBody(budget)) }, timeoutMs);
    } catch (e) {
      throw wrapNetworkError(e, c, timeoutMs);
    }

    const raw = await res.text();
    if (!res.ok) throw Object.assign(new Error(describeHttp(res.status, raw, c)), { code: "LLM_HTTP", status: res.status });

    let json;
    try { json = JSON.parse(raw); } catch { throw new Error(`${c.label} 返回了非 JSON 内容：${raw.slice(0, 200)}`); }

    const out = extractText(json, kind).trim();
    const choice = kind === "anthropic" ? null : (json?.choices || [])[0];
    const msg = (choice && choice.message) || {};
    const stop = String((kind === "anthropic" ? json?.stop_reason : choice?.finish_reason) || "");
    const reasoning = String(msg.reasoning_content || msg.reasoning || "");
    const reasoningTokens = Number(json?.usage?.completion_tokens_details?.reasoning_tokens) || 0;
    const truncated = stop === "length" || stop === "max_tokens";

    if (out) {
      // 有正文、但 finish_reason=length：正文是从中间被 token 上限切断的。
      // 以前这里把半截文本当完整结果返回，分镜 JSON 就会「少一半镜头」还看不出哪里错了（附录 AG）。
      if (truncated && opts.retryOnTruncated !== false && growBudget(
        `正文被 ${budget} token 上限截断（finish_reason=${stop}，已写 ${out.length} 字）`)) continue;
      return opts.withMeta ? { text: out, truncated, stop, budget, reasoningTokens } : out;
    }

    // 正文为空 + 被上限截断 = 推理模型把预算全花在思考上了。放大上限再试一次就能拿到正文。
    if (truncated && growBudget(`这次只输出了思考过程（思考 ${reasoningTokens || "?"} token 被 ${stop} 截断）`)) continue;

    const why = [];
    if (truncated) why.push(`输出被 ${budget} token 上限截断（finish_reason=${stop}）`);
    if (reasoningTokens) why.push(`其中思考就占了 ${reasoningTokens} token`);
    if (reasoning && !truncated) why.push("模型只写了思考过程、没有写正文");
    if (!why.length) why.push(`原始返回：${raw.slice(0, 160)}`);
    throw Object.assign(new Error(
      `${c.label} 没有返回正文（${why.join("；")}）。`
      + "建议：换用非推理模型（例如 deepseek-chat），或把提示词写短一些再试。"),
      { code: "LLM_EMPTY" });
  }
}

/**
 * 连通性测试：优先 GET /models 实时拉取模型清单（OpenAI 与 Anthropic 都是 { data: [{ id }] }），
 * 拉不到就退化成一次极小的对话请求，只回答「OK」。
 */
async function probe(connector, opts = {}) {
  const c = connector || {};
  const base = String(c.baseUrl || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "未填写接口地址" };
  if (!c.apiKey) return { ok: false, error: "未填写 API Key" };
  const timeoutMs = opts.timeoutMs || 30000;

  let listError = null;
  try {
    const res = await fetchWithTimeout(`${base}/models`, { method: "GET", headers: authHeaders(c) }, timeoutMs);
    const raw = await res.text();
    if (res.ok) {
      try {
        const json = JSON.parse(raw);
        const arr = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
        const models = arr.map((m) => (typeof m === "string" ? m : m && (m.id || m.name))).filter(Boolean).sort();
        return { ok: true, models, mode: "models" };
      } catch { listError = "模型列表不是合法 JSON"; }
    } else {
      listError = describeHttp(res.status, raw, c);
    }
  } catch (e) {
    listError = wrapNetworkError(e, c, timeoutMs).message;
  }

  const model = opts.model || c.model;
  if (!model) return { ok: false, error: `${listError}；并且还没有填模型名，无法用对话请求做兜底测试` };

  try {
    const text = await chat(c, { model, system: "你是连通性探针。", user: "只回复 OK 两个字母。", maxTokens: 16, temperature: 0, timeoutMs });
    return { ok: true, models: [model], mode: "chat", echo: text.slice(0, 40), warning: listError };
  } catch (e) {
    // 兜底对话也失败：只有两条错误不同才附加模型列表的报错，避免同一句话重复两遍
    const extra = listError && !e.message.includes(listError) ? `（模型列表接口也没通：${listError}）` : "";
    return { ok: false, error: `${e.message}${extra}` };
  }
}
module.exports = {
  STORE_FILE, PRESETS, DEFAULT_TIMEOUT_MS,
  getPreset, listPublic, listAll, getConnector, listModels,
  buildExternalId, parseExternalId, maskKey,
  createConnector, updateConnector, removeConnector, recordTest,
  chat, probe,
};