"use strict";
/**
 * 歌词「逐字强制对齐」（本机 Whisper，需求报告 附录 AF）。
 *
 * 为什么需要它：歌曲里有间奏（没人唱），而分离出来的人声轨在间奏里仍有伴奏残响。
 * 原来那套「找人声活动区间 → 按字数把歌词摊开」会把间奏也算成演唱时间，
 * 歌词就被摊进间奏里，整段时间轴往后错好几秒（实测《赛博街头短剧》差到 9 秒）。
 *
 * 做法：先让 ASR 听一遍人声轨，拿到「每个字在什么时候唱出来」，
 * 再把歌词与之做一次全局比对（顺序一致、允许错字漏字），
 * 歌词每一行就落在它真正被唱出来的那一刻上。
 *
 * 拿不到 Python / 模型时一律优雅降级：status().available=false，调用方退回原来的估算路径。
 */

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const config = require("./config");
const log = require("./logger").scope("asr");

/** 只保留「可能是歌词的字」：中日韩汉字、假名、谚文、字母、数字 */
const KEEP = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7A3a-zA-Z0-9]/;

function cfg() {
  const c = config.lyrics?.asr || {};
  return {
    enabled: c.enabled !== false,
    pythonPath: String(c.pythonPath || config.runtime?.pythonPath || "").trim(),
    modelDir: String(c.modelDir || "").trim(),
    device: String(c.device || "cuda"),
    compute: String(c.compute || "float16"),
    timeoutMs: Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : 900000,
  };
}

/** 本机 ComfyUI 的根目录（config.vocal.rvcDir = <root>\models\TTS\RVC，两台上层就是根） */
function comfyRoot() {
  const rvc = String(config.vocal?.rvcDir || "").trim();
  if (!rvc) return null;
  let p = path.resolve(rvc);
  for (let i = 0; i < 3; i += 1) p = path.dirname(p);
  return p;
}

function findPython() {
  const c = cfg();
  if (c.pythonPath && fs.existsSync(c.pythonPath)) return c.pythonPath;
  const root = comfyRoot();
  if (root) {
    // 整合包通常把 python 放在 <安装包>\python\，而 ComfyUI 本体在 <安装包>\ComfyUI\：
    // 所以根目录和它的上一级都要找一遍。
    for (const base of [root, path.dirname(root)]) {
      for (const rel of ["python/python.exe", "python/bin/python3", "venv/Scripts/python.exe", "python_embeded/python.exe"]) {
        const p = path.join(base, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

/** 模型目录：config 指定优先，否则在 data/models 下找第一个「有 model.bin 的 whisper 目录」 */
function findModelDir() {
  const c = cfg();
  if (c.modelDir && fs.existsSync(path.join(c.modelDir, "model.bin"))) return c.modelDir;
  const base = path.join(config.paths.data, "models");
  try {
    const hit = fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /whisper/i.test(e.name))
      .map((e) => path.join(base, e.name))
      .find((d) => fs.existsSync(path.join(d, "model.bin")));
    return hit || null;
  } catch {
    return null;
  }
}

function scriptPath() {
  return path.join(__dirname, "..", "tools", "asr_transcribe.py");
}

let cachedStatus = null;

function status({ refresh = false } = {}) {
  if (cachedStatus && !refresh) return cachedStatus;
  const c = cfg();
  const python = findPython();
  const modelDir = findModelDir();
  const script = scriptPath();
  const reasons = [];
  if (!c.enabled) reasons.push("配置里关掉了（config.lyrics.asr.enabled=false）");
  if (!fs.existsSync(script)) reasons.push(`缺少脚本 ${script}`);
  if (!modelDir) reasons.push("还没下载 Whisper 模型（放到 data/models/whisper-*，目录里要有 model.bin）");
  cachedStatus = {
    enabled: c.enabled,
    available: reasons.length === 0,
    python,
    model: modelDir,
    script,
    device: c.device,
    reasons,
  };
  return cachedStatus;
}

function cacheDir() { return path.join(config.paths.data, "cache", "asr"); }

/** 缓存键 = 音频文件指纹：同一段音频只识别一次 */
function fileKey(file) {
  const st = fs.statSync(file);
  return crypto.createHash("sha1")
    .update(`${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}`).digest("hex").slice(0, 16);
}

function runPython(python, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { windowsHide: true });
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出了 */ }
      reject(new Error(`语音识别超时（>${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stderr.on("data", (b) => { err += b.toString(); if (err.length > 8000) err = err.slice(-8000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else reject(new Error(`语音识别失败（exit ${code}）：${err.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 300)}`));
    });
  });
}

/**
 * 识别一段音频 / 视频里的人声，返回带时间戳的字符流（带缓存）。
 * @returns {Promise<{words:Array<{w:string,s:number,e:number}>, segments:Array, cached?:boolean}|null>}
 */
async function transcribe(file, { timeoutMs = null, refresh = false, prompt = "" } = {}) {
  const st = status();
  if (!st.available) return null;
  if (!file || !fs.existsSync(file)) return null;

  const dir = cacheDir();
  // 带提示词的结果要和「没带提示词」的分开缓存，否则换个提示词会命中旧结果
  const pkey = prompt ? `-p${crypto.createHash("sha1").update(String(prompt)).digest("hex").slice(0, 8)}` : "";
  const dest = path.join(dir, `${fileKey(file)}${pkey}.json`);
  if (!refresh && fs.existsSync(dest)) {
    try {
      const j = JSON.parse(await fsp.readFile(dest, "utf8"));
      if (Array.isArray(j.words)) return { ...j, cached: true };
    } catch { /* 缓存坏了就重算 */ }
  }

  await fsp.mkdir(dir, { recursive: true });
  const c = cfg();
  const t0 = Date.now();
  const env = { ...process.env, AVS_ASR_DEVICE: c.device, AVS_ASR_COMPUTE: c.compute };
  await new Promise((resolve, reject) => {
    const args = [st.script, file, st.model, dest];
    if (prompt) args.push("--prompt", String(prompt));
    const child = spawn(st.python, args, { windowsHide: true, env });
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      reject(new Error(`语音识别超时（>${Math.round((timeoutMs || c.timeoutMs) / 1000)}s）`));
    }, timeoutMs || c.timeoutMs);
    child.stderr.on("data", (b) => { err += b.toString(); if (err.length > 8000) err = err.slice(-8000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // ctranslate2 在 Windows 上收尾时偶尔会带着 DLL 崩一下（常见 0xC0000409），
      // 但结果文件早就写好了 —— 只要产物在，就不算失败。
      if (code === 0 || (fs.existsSync(dest) && fs.statSync(dest).size > 2)) resolve();
      else reject(new Error(`语音识别失败（exit ${code}）：${err.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 300)}`));
    });
  });
  const j = JSON.parse(await fsp.readFile(dest, "utf8"));
  log.info(`语音识别完成：${j.words.length} 个字 / ${j.segments.length} 段，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return j;
}

/** 文本 → 字符数组（丢掉标点、空格、装饰符号） */
function charsOf(text) {
  const out = [];
  for (const ch of String(text || "")) if (KEEP.test(ch)) out.push(ch.toLowerCase());
  return out;
}

/**
 * 歌词行 ↔ 识别字符流：全局比对（Needleman–Wunsch）。
 * 顺序必须一致，但允许识别错字、漏字、多字 —— 命中处就是这一行真正被唱出来的位置。
 *
 * @returns {Array<{t:number,ci:number,wi:number}|null>} 每行的最早命中处（秒 / 行内第几个字 / 第几个词）；
 *   整行都没认出来的返回 null（由调用方插值）。ci、wi 让调用方知道「这行是从第几个字才被认出来的」——
 *   只认出了句尾（很常见）时，靠它把整行的起点倒推回去。
 */
function alignLinesDetail(lines, words) {
  const asr = [];
  words.forEach((w, wi) => {
    charsOf(w.w).forEach((ch, k) => asr.push({ ch, t: w.s, wi, k }));
  });
  const ly = [];
  lines.forEach((line, li) => { charsOf(line.text).forEach((ch, k) => ly.push({ ch, li, k })); });

  const n = ly.length;
  const m = asr.length;
  if (!n || !m) return lines.map(() => null);

  const MATCH = 3, MIS = -2, GAP = -2;
  const W = m + 1;
  const dp = new Float64Array((n + 1) * W);
  for (let i = 1; i <= n; i += 1) dp[i * W] = dp[(i - 1) * W] + GAP;
  for (let j = 1; j <= m; j += 1) dp[j] = dp[j - 1] + GAP;
  for (let i = 1; i <= n; i += 1) {
    const lc = ly[i - 1].ch;
    const row = i * W, prevRow = (i - 1) * W;
    for (let j = 1; j <= m; j += 1) {
      const sc = lc === asr[j - 1].ch ? MATCH : MIS;
      const diag = dp[prevRow + j - 1] + sc;
      const up = dp[prevRow + j] + GAP;
      const left = dp[row + j - 1] + GAP;
      dp[row + j] = diag > up ? (diag > left ? diag : left) : (up > left ? up : left);
    }
  }

  const first = new Array(lines.length).fill(null);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const row = i * W, prevRow = (i - 1) * W;
    const cur = dp[row + j];
    const eq = ly[i - 1].ch === asr[j - 1].ch;
    if (eq && Math.abs(cur - (dp[prevRow + j - 1] + MATCH)) < 1e-6) {
      const li = ly[i - 1].li;
      const s = asr[j - 1];
      if (first[li] == null || s.t < first[li].t) first[li] = { t: s.t, ci: ly[i - 1].k, wi: s.wi };
      i -= 1; j -= 1;
    } else if (Math.abs(cur - (dp[prevRow + j] + GAP)) < 1e-6) i -= 1;
    else j -= 1;
  }
  return first;
}

/** 只要「每行从第几秒开始」的老接口（保留给只关心时间的调用方） */
function alignLines(lines, words) {
  return alignLinesDetail(lines, words).map((d) => (d == null ? null : Math.round(d.t * 1000)));
}

/** 唱一个字大概要多久：拿每个 ASR 词的 时长 ÷ 字数 取中位数，顺手滤掉长音和挤在一起的中间件 */
function estimateRate(words) {
  const per = [];
  for (const w of words) {
    const n = charsOf(w.w).length;
    const d = Number(w.e) - Number(w.s);
    if (!n || !(d > 0)) continue;
    const r = d / n;
    if (r >= 0.08 && r <= 1.2) per.push(r);
  }
  if (!per.length) return 0.32;
  per.sort((a, b) => a - b);
  return per[Math.floor(per.length / 2)];
}

/**
 * 一个词的「真实起点」。
 * Whisper 碰到长气口（间奏、换气）会把**紧随其后的第一个词**从气口开头一路拉长 ——
 * 实测《睡不着》里「 我」被拉成 18.10→21.16（一个字占了 3 秒）。
 * 这种词的 start 是假的、end 才是真正的开口，所以超出「正常字数时长」太多就用结尾倒推。
 */
function anchorOf(w, rate, factor = 4) {
  const n = charsOf(w.w).length || 1;
  const hold = Number(w.e) - Number(w.s);
  if (hold > n * rate * factor) return Number(w.e) - n * rate;
  return Number(w.s);
}

/**
 * 给 Whisper 的提示词：拿歌词开头几句当 initial_prompt。
 * 唱词对语音识别是「非母语」内容，开头几句最容易被整段听成幻觉文案（实测听成了「词曲 李宗盛」），
 * 带上歌词去认，这几句才认得出来、才有时间戳。只取开头几行，避免提示词过长被截断。
 */
function promptFromLines(lines, { maxChars = 100, maxLines = 8 } = {}) {
  const parts = [];
  let n = 0;
  for (const l of lines || []) {
    const s = String(l?.text || "").replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (n + s.length > maxChars) break;
    parts.push(s);
    n += s.length;
    if (parts.length >= maxLines) break;
  }
  return parts.join("，");
}

/**
 * 识别结果 + 歌词 → 对齐后的时间轴。
 * 没认出来的行按前后已知行**按字数插值**，保证单调、不重叠。
 */
function alignEntries(lines, words, { totalMs, gapMs = 120, minMs = 700, maxMs = 8000 }) {
  const detail = alignLinesDetail(lines, words);
  const rate = estimateRate(words);   // 秒 / 字
  const n = lines.length;
  // 命中点两步修：① 被长气口拉长的词，用结尾倒推（这种词的 start 是假的）；
  // ② 这一行前面没被认出来的字，按「每字唱多久」往前补 —— 只认出句尾时，整行才不会被判晚。
  const hits = detail.map((d) => {
    if (!d) return null;
    const w = words[d.wi];
    if (!w) return Math.round(d.t * 1000);
    return Math.max(0, Math.round((anchorOf(w, rate) - d.ci * rate) * 1000));
  });
  const known = [];
  for (let i = 0; i < n; i += 1) if (hits[i] != null) known.push(i);
  if (!known.length) return null;

  const starts = hits.slice();
  const charsAt = (i) => Math.max(1, charsOf(lines[i].text).length);
  const spanMs = (i) => charsAt(i) * rate * 1000;
  // 「一句唱完到下一句开口」大概空多久：拿相邻两行都认出来的地方取中位数（头 / 尾用同一个呼吸感）
  const gapList = [];
  for (let k = 0; k + 1 < known.length; k += 1) {
    const a = known[k], b = known[k + 1];
    if (b - a !== 1) continue;
    const g = (hits[b] - hits[a]) / 1000 - charsAt(a) * rate;
    if (g > 0 && g < 8) gapList.push(g);
  }
  gapList.sort((a, b) => a - b);
  const gap = gapList.length ? Math.max(0.3, Math.min(6, gapList[Math.floor(gapList.length / 2)])) : 1.2;
  // 头部：第一行之前没命的，按「这行要唱多久 + 一个气口」往前排。
  // 旧版写死「每行至少往前 1.5 秒」，遇到长句、或开头本来还有前奏时，前几行会被全挤在第一行前头 —— 整段判晚。
  for (let i = known[0] - 1; i >= 0; i -= 1) {
    starts[i] = Math.max(0, Math.round(starts[i + 1] - spanMs(i) - gap * 1000));
  }
  // 两行已知之间没命的，按字数插值
  for (let k = 0; k + 1 < known.length; k += 1) {
    const a = known[k], b = known[k + 1];
    if (b - a <= 1) continue;
    let w = 0;
    for (let i = a; i <= b; i += 1) w += Math.max(1, charsOf(lines[i].text).length);
    let acc = 0;
    for (let i = a + 1; i < b; i += 1) {
      acc += Math.max(1, charsOf(lines[i - 1].text).length);
      starts[i] = Math.round(starts[a] + (starts[b] - starts[a]) * (acc / w));
    }
  }
  // 尾巴
  const tailFrom = known[known.length - 1];
  if (tailFrom < n - 1) {
    let cursor = starts[tailFrom];
    for (let i = tailFrom + 1; i < n; i += 1) {
      cursor += Math.max(1500, Math.round((charsOf(lines[i - 1].text).length / 6) * 1000));
      starts[i] = cursor;
    }
  }

  const out = [];
  for (let i = 0; i < n; i += 1) {
    let start = Math.max(0, Math.round(starts[i] || 0));
    if (i > 0 && start < out[i - 1].startMs + 150) start = out[i - 1].startMs + 150;
    let end = i + 1 < n ? starts[i + 1] : null;
    if (end == null) end = start + maxMs;
    let dur = Math.max(minMs, end - start - gapMs);
    if (start + dur > totalMs) dur = Math.max(200, totalMs - start);
    out.push({ text: lines[i].text, startMs: start, durationMs: Math.min(maxMs, dur) });
  }
  for (let i = 0; i < out.length - 1; i += 1) {
    const maxDur = out[i + 1].startMs - out[i].startMs - 20;
    if (out[i].durationMs > maxDur) out[i].durationMs = Math.max(200, maxDur);
  }
  return out;
}

module.exports = { status, transcribe, alignLines, alignLinesDetail, alignEntries, estimateRate, anchorOf, promptFromLines, charsOf, cfg };