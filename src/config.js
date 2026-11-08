"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = process.env.AVS_CONFIG || path.join(ROOT, "config.json");

function deepMerge(base, extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

let raw = {};
try {
  raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch (err) {
  console.error(`[config] 无法读取 ${CONFIG_PATH}: ${err.message}，使用内置默认值`);
}
if (process.env.AVS_CONFIG_OVERRIDE) {
  try { raw = deepMerge(raw, JSON.parse(process.env.AVS_CONFIG_OVERRIDE)); } catch { /* ignore */ }
}
// 常用环境变量覆盖：PORT / HOST（容器或 systemd 里最省事的改法）
if (process.env.PORT) raw.server = { ...(raw.server || {}), port: Number(process.env.PORT) };
if (process.env.HOST) raw.server = { ...(raw.server || {}), host: process.env.HOST };

const storage = raw.storage || {};
const resolveDir = (p, fallback) => path.resolve(ROOT, p || fallback);
const dataDir = resolveDir(storage.dataDir, "./data");

const config = {
  ROOT,
  configPath: CONFIG_PATH,
  server: { host: "0.0.0.0", port: 8899, ...(raw.server || {}) },
  comfy: {
    instances: [],
    connectTimeoutMs: 20000,
    uploadTimeoutMs: 300000,
    promptTimeoutMs: 60000,
    imageJobTimeoutMs: 600000,
    videoJobTimeoutMs: 3600000,
    idleFreeSeconds: 300,
    objectInfoCacheSeconds: 600,
    // 任务跑完后自动还显存的冷却（秒）：
    //   · 重型任务（视频/音频）结束 → quietFreeSeconds 后检查一次，整机安静就把模型卸掉；
    //   · 其它任务（图片等）→ 由巡检兜底，同一张卡连续空闲 idleFreeSeconds 才回收。
    // 冷却期的意义：用户连着改提示词、反复生成时，模型继续热着，下一张图不用重新加载。
    quietFreeSeconds: 20,
    // ComfyUI 的音频合成工作流（WF-18M / WF-25）必须把整段视频解码进内存，
    // 这里按「解码后的帧缓冲」设一个安全预算（GB）：超了就直接报错并引导去「配音」页。
    audioMuxMaxDecodeGB: 40,
    ...(raw.comfy || {}),
  },
  limits: {
    maxUploadMB: 200,
    maxRefAssets: 20,
    videoMaxDurationS: 20,
    maxRefImagesPerRequest: 9,
    maxRefVideosPerRequest: 3,
    maxRefAudiosPerRequest: 3,
    aspects: {},
    ...(raw.limits || {}),
  },
  export: { codec: "h264", crf: 16, targetFps: 24, watermark: false, ...(raw.export || {}) },
  // 本机运行时依赖（Python / ffmpeg）：留空则按 src/python.js、src/ffmpeg.js 的候选顺序自动探测
  runtime: { pythonPath: "", ffmpegPath: "", ...(raw.runtime || {}) },
  // 本机成片合成参数（配音 / 换音轨：视频流直拷，只重编码音轨）
  mux: { audioBitrate: "192k", sampleRate: 44100, channels: 2, fallbackCrf: 18, ...(raw.mux || {}) },
  auth: { enabled: false, username: "admin", password: "admin123", jwtSecret: "change-me", ...(raw.auth || {}) },
  promptEngine: { enabled: true, clipName: "qwen_3_4b.safetensors", clipType: "ltxv", ...(raw.promptEngine || {}) },
  // AI 翻唱：跑在**本机**（192.168.0.128）的 ComfyUI 上 —— RVC / Demucs / ACE-Step 权重只在那台机器
  vocal: {
    localInstance: "comfyui:local",
    machine: "本机 192.168.0.128",
    rvcDir: "E:\\ComfyUI-aki-v2\\ComfyUI\\models\\TTS\\RVC",
    ...(raw.vocal || {}),
  },

  // AI 创作音乐：同样跑在**本机**（192.168.0.128）—— MiniMax Music 3 / YuE2 / ACE-Step 权重只在那台机器
  music: {
    localInstance: "comfyui:local",
    machine: "本机 192.168.0.128",
    ...(raw.music || {}),
  },

  // 歌词 → 字幕（本机 Whisper 逐字对齐：见 src/asr.js 与需求报告 附录 AF）
  // pythonPath / modelDir 留空就自动探测（ComfyUI 整合包的 python、data/models/whisper-*）
  lyrics: {
    ...(raw.lyrics || {}),
    asr: {
      enabled: true, pythonPath: "", modelDir: "", device: "cuda", compute: "float16", timeoutMs: 900000,
      ...(raw.lyrics?.asr || {}),
    },
  },

  // 语音合成（视频配音 / 故事创作带声音）：provider 列表落盘在 data/tts.json

  tts: { pythonPath: "", defaultProvider: "tts_edge", defaultVoice: "zh-CN-XiaoxiaoNeural", maxChars: 2000, timeoutMs: 120000, edgeAttempts: 3, ...(raw.tts || {}) },
  paths: {
    data: dataDir,
    exports: resolveDir(storage.exportsDir, "./data/exports"),
    uploads: resolveDir(storage.uploadsDir, "./data/uploads"),
    thumbs: resolveDir(storage.thumbsDir, "./data/thumbs"),
    renders: resolveDir(storage.rendersDir, "./data/renders"),
    drafts: resolveDir(storage.draftsDir, "./data/drafts"),
    logs: resolveDir(storage.logsDir, "./data/logs"),
    workflows: resolveDir(storage.workflowsDir, "./data/workflows"),
    dbFile: path.join(dataDir, "app.db"),
    comfyOutputCleanupHours: storage.comfyOutputCleanupHours ?? 24,
    assetRetentionDays: storage.assetRetentionDays ?? 30,
  },
};

for (const dir of Object.values(config.paths)) {
  if (typeof dir === "string" && !dir.endsWith(".db")) fs.mkdirSync(dir, { recursive: true });
}

// 归一化实例列表：补全 id / cuda / enabled
config.comfy.instances = (config.comfy.instances || [])
  .filter((i) => i && i.url)
  .map((i, idx) => ({
    id: i.id || `comfyui:${new URL(i.url).port || 8188}`,
    url: i.url.replace(/\/+$/, ""),
    cuda: Number.isInteger(i.cuda) ? i.cuda : idx,
    enabled: i.enabled !== false,
    maxConcurrent: i.maxConcurrent || 1,
    label: i.label || `GPU ${Number.isInteger(i.cuda) ? i.cuda : idx}`,
    // 专用实例（本机 192.168.0.128 上的 ComfyUI）：只服务点名要用它的工作流
    // （wf.instances 里写了它的 id），不参与通用调度。
    local: i.local === true,
    workflows: Array.isArray(i.workflows) ? i.workflows.filter(Boolean) : null,
  }));


module.exports = config;
