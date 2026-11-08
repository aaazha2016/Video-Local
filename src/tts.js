"use strict";
/**
 * 语音合成（TTS）服务层 —— 「视频配音」与「故事创作 · 带声音」共用。
 *
 * 两条通路：
 *   1) kind = "edge"   ：本机 Python + edge-tts，免费、不需要 Key，中文音色齐全（默认内置）。
 *   2) kind = "openai" ：任何 OpenAI 兼容的 POST /audio/speech 端点，包括
 *                        硅基流动 CosyVoice2 / 阿里云百炼 / OpenAI / 自建的本地 TTS 服务。
 *
 * 配置落盘在 data/tts.json，结构与 data/external-llm.json 对齐：
 *   { version:1, providers:[{ id,label,kind,baseUrl,apiKey,model,voice,enabled,lastTest,createdAt,updatedAt }] }
 * 没有配置任何外部服务时，自动启用内置的 edge（id=tts_edge），开箱即用、不花钱、不出网。
 *
 * 合成结果会落成一条 kind="audio" 的素材，随后由 jobs.buildContext 上传到 ComfyUI 的
 * input 目录，交给 WF-25 / WF-26 挂到画面上（本地节点完成，不消耗 222 的模型配额）。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const config = require("./config");
const log = require("./logger").scope("tts");
const store = require("./store");
const naming = require("./naming");

const STORE_FILE = path.join(config.paths.data, "tts.json");
const DEFAULT_TIMEOUT_MS = 120000;
const EDGE_ID = "tts_edge";

/** 内置中文音色（edge-tts）。tags 只用于前端展示与筛选。 */
const EDGE_VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 女声 · 温柔亲和", lang: "zh-CN", gender: "female", tags: ["口播", "通用", "温柔"] },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊 · 女声 · 活泼俏皮", lang: "zh-CN", gender: "female", tags: ["带货", "vlog"] },
  { id: "zh-CN-YunxiNeural", label: "云希 · 男声 · 阳光少年", lang: "zh-CN", gender: "male", tags: ["剧情", "解说"] },
  { id: "zh-CN-YunjianNeural", label: "云健 · 男声 · 沉稳浑厚", lang: "zh-CN", gender: "male", tags: ["解说", "纪录片"] },
  { id: "zh-CN-YunyangNeural", label: "云扬 · 男声 · 新闻播报", lang: "zh-CN", gender: "male", tags: ["新闻", "资讯"] },
  { id: "zh-CN-YunxiaNeural", label: "云夏 · 男声 · 少年感", lang: "zh-CN", gender: "male", tags: ["动漫", "短剧"] },
  { id: "zh-CN-liaoning-XiaobeiNeural", label: "晓北 · 女声 · 东北话", lang: "zh-CN", gender: "female", tags: ["搞笑", "方言"] },
  { id: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮 · 女声 · 陕西话", lang: "zh-CN", gender: "female", tags: ["搞笑", "方言"] },
  { id: "zh-HK-HiuMaanNeural", label: "曉曼 · 女声 · 粤语", lang: "zh-HK", gender: "female", tags: ["粤语"] },
  { id: "zh-TW-HsiaoChenNeural", label: "曉臻 · 女声 · 台湾腔", lang: "zh-TW", gender: "female", tags: ["台湾腔"] },
  { id: "en-US-AriaNeural", label: "Aria · 英文女声", lang: "en-US", gender: "female", tags: ["英文"] },
  { id: "en-US-GuyNeural", label: "Guy · 英文男声", lang: "en-US", gender: "male", tags: ["英文"] },
  { id: "ja-JP-NanamiNeural", label: "ナナミ · 日文女声", lang: "ja-JP", gender: "female", tags: ["日文"] },
  { id: "ko-KR-SunHiNeural", label: "선히 · 韩文女声", lang: "ko-KR", gender: "female", tags: ["韩文"] },
];

/** 常见厂商预设：baseUrl / model 只是默认值，界面上可以随时改 */
const PRESETS = [
  {
    id: "edge", label: "本机语音合成（edge-tts · 免费无需 Key）", kind: "edge",
    baseUrl: "", model: "", auth: "none",
    note: "跑在这台机器上，只需要一个装了 edge-tts 的 Python；中文音色齐全、不花钱。",
  },
  {
    id: "siliconflow", label: "硅基流动 CosyVoice2", kind: "openai",
    baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/CosyVoice2-0.5B",
    voices: ["alex", "benjamin", "anna", "bella", "david", "diana"], auth: "bearer",
    note: "国内直连、按量计费；和 222 上放着的 CosyVoice2-0.5B 是同一个模型。",
  },
  {
    id: "dashscope", label: "阿里云百炼 CosyVoice", kind: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "cosyvoice-v2",
    voices: ["longxiaochun", "longxiaoxia", "longwan", "longcheng", "longhua"], auth: "bearer",
    note: "国内直连；音色名形如 longxiaochun。",
  },
  {
    id: "openai", label: "OpenAI TTS", kind: "openai",
    baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts",
    voices: ["alloy", "verse", "nova", "shimmer", "echo", "fable", "onyx"], auth: "bearer",
    note: "音质自然，但通常需要海外网络。",
  },
  {
    id: "local", label: "自建本地 TTS 服务（192.168.0.222）", kind: "openai",
    baseUrl: "http://192.168.0.222:9880/v1", model: "cosyvoice2",
    voices: ["中文女", "中文男", "粤语女"], auth: "none",
    note: "把 222 上的 CosyVoice2 用 OpenAI 兼容壳跑起来后填这里，实现全本地配音。",
  },
  {
    id: "custom", label: "自定义（OpenAI 兼容 /audio/speech）", kind: "openai",
    baseUrl: "", model: "", voices: [], auth: "bearer",
    note: "任何 OpenAI 兼容的语音网关，例如 one-api / new-api / 自建 vLLM-TTS。",
  },
];

const getPreset = (id) => PRESETS.find((p) => p.id === id) || null;
const bad = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

// ------------------------------------------------------------------ 落盘
function loadAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return { version: 1, providers: Array.isArray(raw && raw.providers) ? raw.providers : [] };
  } catch (e) {
    if (e.code !== "ENOENT") log.warn(`读取 ${STORE_FILE} 失败：${e.message}`);
    return { version: 1, providers: [] };
  }
}

function saveAll(data) {
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
  try { fs.chmodSync(STORE_FILE, 0o600); } catch { /* Windows 上无此语义，忽略 */ }
}

const newProviderId = () => `tts_${crypto.randomBytes(5).toString("hex")}`;

function maskKey(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}${"*".repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`;
}

/** 没配置任何服务时的兜底：直接可用、免费的本机 edge 通道 */
function builtinProvider() {
  return {
    id: EDGE_ID, label: "本机语音合成（edge-tts · 免费）", kind: "edge",
    baseUrl: "", apiKey: "", model: "", voice: config.tts.defaultVoice,
    enabled: true, builtin: true, lastTest: null, createdAt: null, updatedAt: null,
  };
}

function publicProvider(p) {
  const preset = getPreset(p.preset);
  return {
    id: p.id, label: p.label, preset: p.preset || null, kind: p.kind || "edge",
    base_url: p.baseUrl || "", model: p.model || "", voice: p.voice || "",
    voices: voicesFor(p).map((v) => v.id),
    enabled: p.enabled !== false, builtin: !!p.builtin,
    has_key: !!p.apiKey, api_key_masked: maskKey(p.apiKey),
    last_test: p.lastTest || null,
    note: preset?.note || null,
    created_at: p.createdAt || null, updated_at: p.updatedAt || null,
  };
}

const listAll = () => loadAll().providers;

/** 内置 edge + 用户配置的服务（id 冲突时以用户配置的为准） */
function allProviders() {
  const stored = listAll();
  return stored.some((p) => p.id === EDGE_ID) ? stored : [builtinProvider(), ...stored];
}

function getProvider(id) {
  const list = allProviders();
  if (!id) return list.find((p) => p.id === (config.tts.defaultProvider || EDGE_ID)) || list[0] || null;
  return list.find((p) => p.id === id) || null;
}

function createProvider(body = {}) {
  const preset = getPreset(body.preset) || null;
  const kind = body.kind || preset?.kind || "openai";
  const p = {
    id: body.id && /^[A-Za-z0-9_:-]+$/.test(body.id) ? body.id : newProviderId(),
    label: body.label || preset?.label || "未命名语音服务",
    preset: body.preset || null,
    kind,
    baseUrl: String(body.baseUrl ?? preset?.baseUrl ?? "").replace(/\/+$/, ""),
    apiKey: String(body.apiKey ?? ""),
    model: String(body.model ?? preset?.model ?? ""),
    voice: String(body.voice ?? (voicesFor({ kind, preset: body.preset })[0]?.id || "")),
    enabled: body.enabled !== false,
    lastTest: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const data = loadAll();
  if (data.providers.some((x) => x.id === p.id)) throw bad("TTS_DUP", `服务 id 已存在：${p.id}`);
  data.providers.push(p);
  saveAll(data);
  log.info(`新增语音服务 ${p.id}（${p.kind}）`);
  return publicProvider(p);
}

function updateProvider(id, patch = {}) {
  const data = loadAll();
  const i = data.providers.findIndex((x) => x.id === id);
  if (i < 0) throw bad("TTS_NOT_FOUND", `语音服务不存在：${id}`, 404);
  const cur = data.providers[i];
  const next = { ...cur };
  for (const k of ["label", "preset", "kind", "model", "voice"]) {
    if (patch[k] !== undefined) next[k] = String(patch[k] ?? "");
  }
  if (patch.baseUrl !== undefined) next.baseUrl = String(patch.baseUrl || "").replace(/\/+$/, "");
  if (patch.enabled !== undefined) next.enabled = patch.enabled !== false;
  // apiKey 留空表示「不修改」，要清空请显式传 apiKey:"" + clear_key:true
  if (patch.apiKey) next.apiKey = String(patch.apiKey);
  else if (patch.clear_key === true) next.apiKey = "";
  next.updatedAt = new Date().toISOString();
  data.providers[i] = next;
  saveAll(data);
  return publicProvider(next);
}

function removeProvider(id) {
  const data = loadAll();
  const before = data.providers.length;
  data.providers = data.providers.filter((x) => x.id !== id);
  if (data.providers.length === before) throw bad("TTS_NOT_FOUND", `语音服务不存在：${id}`, 404);
  saveAll(data);
  return { deleted: true };
}

function recordTest(id, result) {
  const data = loadAll();
  const p = data.providers.find((x) => x.id === id);
  if (!p) return null;
  p.lastTest = { at: new Date().toISOString(), ...result };
  saveAll(data);
  return publicProvider(p);
}

/** 某个服务可选的音色：edge 用内置表，OpenAI 兼容端点用预设给的清单（也可手填任意音色名） */
function voicesFor(p) {
  if (!p) return EDGE_VOICES;
  if ((p.kind || "edge") === "edge") return EDGE_VOICES;
  const preset = getPreset(p.preset);
  const ids = Array.isArray(preset?.voices) ? preset.voices : [];
  return ids.map((id) => ({ id, label: id, lang: "-", gender: "-", tags: [] }));
}

// ------------------------------------------------------- 本机 Python（edge 通道）
let pyCache = null;

function pyCandidates() {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  add(config.tts.pythonPath);
  add(process.env.AVS_TTS_PYTHON);
  // 本机默认装在 Codex 运行时的 Python 里
  const roots = [path.join(os.homedir(), ".cache", "codex-runtimes")];
  for (const root of roots) {
    try {
      for (const d of fs.readdirSync(root)) {
        add(path.join(root, d, "dependencies", "python", "python.exe"));
        add(path.join(root, d, "dependencies", "python", "bin", "python3"));
      }
    } catch { /* 目录不存在就算了 */ }
  }
  add("python3");
  add("python");
  return out;
}

function run(cmd, args, { timeoutMs = DEFAULT_TIMEOUT_MS, input = null, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", ...env } });
    } catch (e) { reject(e); return; }
    let out = ""; let err = ""; let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(bad("TTS_TIMEOUT", `语音合成超时（>${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      reject(bad("TTS_SPAWN", `无法执行 ${cmd}：${e.message}`));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(bad("TTS_EXIT", `${cmd} 退出码 ${code}${err ? `：${err.trim().slice(0, 400)}` : ""}`));
    });
    if (input !== null) { child.stdin.end(input); } else { child.stdin?.end(); }
  });
}

/** 找一个装了 edge-tts 的 Python；找不到就报一句人话给前端 */
async function resolvePython() {
  if (pyCache && pyCache.ok) return pyCache.exe;
  const tried = [];
  for (const exe of pyCandidates()) {
    try {
      const r = await run(exe, ["-c", "import edge_tts;print('EDGE_OK')"], { timeoutMs: 20000 });
      if (String(r.stdout).includes("EDGE_OK")) {
        pyCache = { ok: true, exe, at: Date.now() };
        log.info(`语音合成引擎就绪：${exe}`);
        return exe;
      }
      tried.push(`${exe}（未安装 edge-tts）`);
    } catch (e) {
      tried.push(`${exe}（${String(e.message).slice(0, 60)}）`);
    }
  }
  pyCache = { ok: false, at: Date.now() };
  throw bad("TTS_PYTHON_MISSING",
    `没有找到可用的语音引擎。请在任意 Python 里执行 pip install edge-tts，或在 config.json 的 tts.pythonPath 指到那个 python.exe。已尝试：${tried.join("；")}`);
}

/** 纯 ASCII 的 JSON，避免 Windows 管道把中文按 GBK 编码传坏 */
function asciiJson(obj) {
  return JSON.stringify(obj).replace(/[^\x00-\x7F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * edge-tts 的执行脚本（把 JSON 从 stdin 喂进去，纯 ASCII，避免 Windows 管道把中文编码搞坏）。
 *
 * 两个务必保留的细节：
 *   1) 显式传一个「只走 IPv4」的 TCPConnector。edge-tts 默认 family=AF_UNSPEC，
 *      拿到的 DNS 里既有 AAAA 也有 A，会先去试 IPv6；而这台机器到
 *      speech.platform.bing.com 的 IPv6 会被中途重置（WinError 64 / 10054），
 *      表现就是「同一条配音，有时候成、有时候败」。强制 IPv4 之后就稳定了。
 *   2) 自带重试：在线接口偶发抖动时不至于让用户的配音直接失败。
 */
const EDGE_RUNNER = [
  "import sys, json, asyncio, socket",
  "import aiohttp",
  "import edge_tts",
  "cfg = json.load(sys.stdin)",
  "",
  "async def synth_once(out, kwargs):",
  "    conn = aiohttp.TCPConnector(family=socket.AF_INET, ttl_dns_cache=300)",
  "    try:",
  "        try:",
  "            c = edge_tts.Communicate(cfg['text'], cfg['voice'], connector=conn, **kwargs)",
  "        except TypeError:",
  "            c = edge_tts.Communicate(cfg['text'], cfg['voice'], **kwargs)   # 老版本不支持 connector",
  "        await c.save(out)",
  "    finally:",
  "        try:",
  "            await conn.close()",
  "        except Exception:",
  "            pass",
  "",
  "async def main():",
  "    kwargs = dict(rate=cfg['rate'], volume=cfg['volume'], pitch=cfg['pitch'])",
  "    attempts = int(cfg.get('attempts') or 3)",
  "    last = None",
  "    for i in range(attempts):",
  "        try:",
  "            await synth_once(cfg['out'], kwargs)",
  "            return",
  "        except Exception as e:",
  "            last = e",
  "            if i < attempts - 1:",
  "                await asyncio.sleep(1.2 * (i + 1))",
  "    raise last",
  "",
  "asyncio.run(main())",
].join("\n");

const asPercent = (v, d = 0) => {
  const n = Number.isFinite(Number(v)) ? Math.round(Number(v)) : d;
  return `${n >= 0 ? "+" : ""}${n}%`;
};
const asHz = (v) => {
  const n = Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0;
  return `${n >= 0 ? "+" : ""}${n}Hz`;
};

async function edgeSynthesize(provider, { text, voice, rate, volume, pitch }) {
  const exe = await resolvePython();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "avs-tts-"));
  const out = path.join(dir, "voice.mp3");
  try {
    try {
      await run(exe, ["-c", EDGE_RUNNER], {
        timeoutMs: config.tts.timeoutMs || DEFAULT_TIMEOUT_MS,
        input: asciiJson({
          text, out,
          voice: voice || provider.voice || config.tts.defaultVoice,
          rate: asPercent(rate, 0), volume: asPercent(volume, 0), pitch: asHz(pitch),
          attempts: config.tts.edgeAttempts || 3,
        }),
      });
    } catch (e) {
      // 本机免费通道走的是微软在线接口：网络被掐断时把 traceback 换成人话，
      // 并明确告诉用户「已经重试过了、可以怎么办」。
      const lines = String(e.stderr || e.message || "").split(/\r?\n/).filter((x) => x.trim());
      const tail = lines.length ? lines[lines.length - 1].trim() : "未知原因";
      throw bad("TTS_ENGINE_FAILED",
        `本机语音合成失败（已自动重试 ${config.tts.edgeAttempts || 3} 次）：${tail.slice(0, 200)}　` +
        "免费通道连的是微软的在线接口，网络波动时会连不上；可以稍后重试，或在「⚙️ 语音服务」里换成已配置好的外部语音服务。");
    }
    const buffer = await fsp.readFile(out);
    if (!buffer.length) throw bad("TTS_EMPTY", "语音引擎没有输出音频数据");
    return { buffer, ext: ".mp3", mime: "audio/mpeg" };
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function openaiSynthesize(provider, { text, voice, speed }) {
  const base = String(provider.baseUrl || "").replace(/\/+$/, "");
  if (!base) throw bad("TTS_CONFIG", `语音服务「${provider.label}」还没填接口地址`);
  const model = provider.model;
  if (!model) throw bad("TTS_CONFIG", `语音服务「${provider.label}」还没填模型名`);
  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const body = {
    model,
    input: text,
    voice: voice || provider.voice || "alloy",
    response_format: "mp3",
    speed: Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : undefined,
  };
  if (body.speed === undefined) delete body.speed;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), config.tts.timeoutMs || DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}/audio/speech`, {
      method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
  } catch (e) {
    throw bad("TTS_NETWORK", `语音服务「${provider.label}」请求失败：${e.message}。请确认地址正确、网络可达。`, 502);
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw bad("TTS_HTTP", `语音服务「${provider.label}」返回 HTTP ${res.status}：${raw.slice(0, 300)}`, 502);
  }
  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  if (!buffer.length) throw bad("TTS_EMPTY", `语音服务「${provider.label}」没有返回音频数据`, 502);
  const ct = String(res.headers.get("content-type") || "");
  const ext = ct.includes("wav") ? ".wav" : ct.includes("mpeg") || ct.includes("mp3") ? ".mp3" : ".mp3";
  return { buffer, ext, mime: ext === ".wav" ? "audio/wav" : "audio/mpeg" };
}

/** 统一入口：文字 -> 音频字节 */
async function synthesize({ provider, providerId, text, voice, rate, volume, pitch, speed } = {}) {
  const p = provider || getProvider(providerId);
  if (!p) throw bad("TTS_NO_PROVIDER", `语音服务不存在：${providerId || "(默认)"}`);
  if (p.enabled === false) throw bad("TTS_DISABLED", `语音服务「${p.label}」已停用`);
  const t = String(text || "").trim();
  if (!t) throw bad("TTS_TEXT_EMPTY", "请先输入要配音的文字");
  if (t.length > (config.tts.maxChars || 2000)) {
    throw bad("TTS_TOO_LONG", `单次配音文字太长（${t.length} 字），请拆成多段，每段不超过 ${config.tts.maxChars || 2000} 字`);
  }
  return (p.kind || "edge") === "edge"
    ? edgeSynthesize(p, { text: t, voice, rate, volume, pitch })
    : openaiSynthesize(p, { text: t, voice, speed });
}

/**
 * 合成并把结果落成一条 audio 素材（供 refs.audio / refs.speech 引用）。
 * @returns {Promise<{asset:object, provider:string, voice:string, chars:number}>}
 */
async function synthesizeToAsset({ text, providerId, voice, rate, volume, pitch, speed, projectId = null, shotId = null, jobId = null } = {}) {
  const p = getProvider(providerId);
  const { buffer, ext, mime } = await synthesize({ provider: p, text, voice, rate, volume, pitch, speed });
  const dir = path.join(config.paths.uploads, projectId || "common");
  await fsp.mkdir(dir, { recursive: true });
  const sha = crypto.createHash("sha256").update(buffer).digest("hex");
  const file = await naming.nextAssetPath(dir, { projectId, kind: "audio", ext });
  await fsp.writeFile(file, buffer);
  const rel = path.relative(config.paths.data, file).split(path.sep).join("/");
  const usedVoice = voice || p.voice || config.tts.defaultVoice;
  const asset = store.asset.create({
    project_id: projectId, shot_id: shotId, job_id: jobId,
    kind: "audio", path: file, url: `/files/${rel}`, mime,
    size_bytes: buffer.length, has_audio: true, watermark: false,
    meta: { sha256: sha, origin_name: `tts${ext}`, tts: { provider: p.id, voice: usedVoice, chars: String(text).length } },
  });
  log.info(`语音合成完成：${String(text).slice(0, 20)}…（${String(text).length} 字，${(buffer.length / 1024).toFixed(0)}KB，音色 ${usedVoice}）`);
  return { asset, provider: p.id, voice: usedVoice, chars: String(text).length };
}

/** 连通性测试：edge 就检查 Python+edge-tts；OpenAI 兼容的就真的合成一句短话 */
async function probe(providerOrId) {
  const p = typeof providerOrId === "string" ? getProvider(providerOrId) : (providerOrId || getProvider());
  if (!p) return { ok: false, error: "语音服务不存在" };
  try {
    if ((p.kind || "edge") === "edge") {
      const exe = await resolvePython();
      // 不调 --list-voices（它走 HTTPS，本机可能被拦），直接试合成一句最短的话最靠谱
      const { buffer } = await synthesize({ provider: p, text: "配音测试", voice: p.voice });
      return {
        ok: true, engine: "edge-tts", python: exe, bytes: buffer.length,
        message: `本机语音引擎可用（${(buffer.length / 1024).toFixed(1)}KB 试听音频）`,
      };
    }
    const { buffer, ext } = await synthesize({ provider: p, text: "你好，这是一条配音测试。", voice: p.voice });
    return { ok: true, engine: p.model, bytes: buffer.length, format: ext, message: `合成成功，得到 ${(buffer.length / 1024).toFixed(1)}KB ${ext} 音频` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 给前端的总览 */
async function status() {
  let edge = { available: false, python: null, voices: EDGE_VOICES.length };
  try { edge = { available: true, python: await resolvePython(), voices: EDGE_VOICES.length }; }
  catch (e) { edge.error = e.message; }
  return {
    default: config.tts.defaultProvider || EDGE_ID,
    default_voice: config.tts.defaultVoice,
    max_chars: config.tts.maxChars || 2000,
    edge,
    presets: PRESETS,
    providers: allProviders().map(publicProvider),
    voices: Object.fromEntries(allProviders().map((p) => [p.id, voicesFor(p)])),
  };
}

module.exports = {
  STORE_FILE, EDGE_ID, EDGE_VOICES, PRESETS,
  getPreset, getProvider, allProviders, listAll, listPublic: () => allProviders().map(publicProvider),
  createProvider, updateProvider, removeProvider, recordTest, voicesFor,
  resolvePython, synthesize, synthesizeToAsset, probe, status,
};