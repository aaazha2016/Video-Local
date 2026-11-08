"use strict";
/**
 * 歌词 → 字幕：把「歌词 / 台词」和「音频 / 视频」对齐，导出标准的字幕文件。
 *
 * 为什么单独一层（而不是并进 subtitle.js）：
 *   subtitle.js 管的是「分镜台词 → 按镜头时间轴烧字幕」，时间轴来自分镜表本身；
 *   这一层管的是「一整段歌 / 一段旁白录音 + 一份歌词文本 → 时间轴得现算出来」，
 *   输入、算法、产物格式都不一样（多了 .lrc 这个音频播放器的标准歌词格式）。
 *
 * 对齐有三种办法，按可靠性从高到低自动挑（也可以手动指定）：
 *   ① timed  —— 歌词本身就带时间轴（.lrc / .srt），直接用，最准；
 *   ② speech —— 歌词没时间轴时，先找出「有人声的片段」，再把每行歌词按字数比例铺到这些区间上。
 *               标尺有两种拿法：先用本机 Demucs 分离出纯人声再找（准，歌曲必须这么做），
 *               退而求其次才直接在混音上按相对响度找（快，但带伴奏时只能算估）；
 *   ③ even   —— 整段按字数比例均分。兜底，永远能用。
 * 注意 ② 只是「按停顿切句」，不是语音识别：它不会去认你唱了什么，只借停顿位置当标尺，
 * 所以歌词是你给的那份、一个字都不会被改。
 *
 * 产物（都是标准格式，播放器 / 剪映 / 剪辑软件直接认）：
 *   .lrc —— 音频播放器的标准歌词；.srt —— SubRip，视频与剪映通用；
 *   .ass —— 高级字幕，本机烧硬字幕就用它。
 * 需要的话还能一键把字幕烧进画面（复用 subtitle.js，本机 ffmpeg，不占 222 的显存）。
 */

const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");

const config = require("./config");
const log = require("./logger").scope("lyrics");
const ffmpeg = require("./ffmpeg");
const proc = require("./proc");
const naming = require("./naming");
const subtitle = require("./subtitle");
const { readVideoMeta } = require("./mp4");
const asr = require("./asr");       // 本机 Whisper 逐字对齐（拿不到就退回估算，见 asr.status().available）

const bad = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const pad = (n, w = 2) => String(n).padStart(w, "0");
const NUL = process.platform === "win32" ? "NUL" : "-";
const MAX_LINES = 500;
const CJK = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

// ------------------------------------------------------------------ 解析歌词

const LRC_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const LRC_META = /^\[(ti|ar|al|by|offset|re|ve|length|au):([^\]]*)\]/i;
const SRT_TIME = /(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;
const SECTION_WORD = /^(verse|chorus|bridge|intro|outro|prechorus|hook|refrain|main|solo|interlude|instrumental|间奏|前奏|尾奏|主歌|副歌|桥段|高潮|结尾|开场|序曲|music)$/i;

/** 「[Verse 1]」「【副歌】」这类段落标记，不是歌词本身 */
function isSectionLine(s) {
  const bare = String(s || "").replace(/[[\]【】()（）<>《》:：\s]/g, "").replace(/\d+$/, "");
  if (!bare) return true;
  return SECTION_WORD.test(bare);
}

/**
 * LRC 的 [分:秒.厘秒] → 毫秒。
 * 注意：LRC 标准是「分:秒.小数」，**没有小时位** —— 写成 时:分 会把 3 分 20 秒算成 3 小时 20 分，
 * 结果整首歌的字幕全被挤到时间轴末尾（实测踩过）。
 * 小数位按位数解释：1 位 = 十分之一秒，2 位 = 厘秒，3 位 = 毫秒。
 */
function lrcStampToMs(min, sec, frac) {
  let ms = 0;
  if (frac != null) {
    const f = String(frac);
    ms = f.length === 1 ? Number(f) * 100 : f.length === 2 ? Number(f) * 10 : Number(f.slice(0, 3));
  }
  return (Number(min) * 60 + Number(sec)) * 1000 + ms;
}

const hmsToMs = (h, m, s, ms) => Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + Number(ms);

/**
 * 解析歌词文本。三种写法都认（自动判断）：
 *   · .lrc  —— [00:12.34]歌词（一行多个时间戳也支持）+ [ti:]/[ar:]/[offset:] 元信息
 *   · .srt  —— 带 --> 时间码的字幕块
 *   · 纯文本 —— 一行一句；空行分段；"1. " 行号与 [Verse] 段落标记自动丢掉
 * @returns {{lines:Array<{text:string,startMs:number|null,endMs:number|null}>, timed:boolean, source:string, offsetMs:number, meta:object}}
 */
function parseLyrics(input) {
  const raw = String(input == null ? "" : input).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!raw.trim()) throw bad("NO_LYRICS", "还没有歌词：粘贴歌词，或上传 .txt / .lrc / .srt 文件");
  const rows = raw.split("\n");
  if (rows.some((l) => SRT_TIME.test(l))) return parseSrt(raw);
  if (rows.some((l) => { LRC_TAG.lastIndex = 0; return LRC_TAG.test(l); })) return parseLrc(raw);
  return parsePlain(rows);
}

function parseSrt(raw) {
  const out = [];
  for (const block of raw.replace(/\n{3,}/g, "\n\n").split(/\n{2,}/)) {
    const ls = block.split("\n").map((s) => s.trim()).filter(Boolean);
    const ti = ls.findIndex((l) => SRT_TIME.test(l));
    if (ti < 0) continue;
    const m = SRT_TIME.exec(ls[ti]);
    const text = ls.slice(ti + 1).join("\n").trim();
    if (!text) continue;
    out.push({
      text,
      startMs: hmsToMs(m[1], m[2], m[3], m[4]),
      endMs: hmsToMs(m[5], m[6], m[7], m[8]),
    });
  }
  if (!out.length) throw bad("LYRICS_UNPARSED", "这份 .srt 里没有解析出可用的字幕行");
  out.sort((a, b) => a.startMs - b.startMs);
  return { lines: out, timed: true, source: "srt", offsetMs: 0, meta: {} };
}

function parseLrc(raw) {
  const out = [];
  const meta = {};
  let offsetMs = 0;
  for (const line of raw.split("\n")) {
    const mm = LRC_META.exec(line.trim());
    if (mm) {
      const key = mm[1].toLowerCase();
      const val = mm[2].trim();
      if (key !== "offset") meta[key] = val;
      if (key === "offset") { const n = Number(val); if (Number.isFinite(n)) offsetMs = Math.round(n); }
      continue;
    }
    LRC_TAG.lastIndex = 0;
    const stamps = [];
    let last = 0;
    let m;
    while ((m = LRC_TAG.exec(line)) !== null) { stamps.push(lrcStampToMs(m[1], m[2], m[3])); last = m.index + m[0].length; }
    if (!stamps.length) continue;                       // LRC 里没打时间戳的行当注释丢掉
    const text = line.slice(last).trim();
    if (!text || isSectionLine(text)) continue;         // 空行 / [副歌] 这种段落标记不算歌词
    for (const ms of stamps) out.push({ text, startMs: ms, endMs: null });
  }
  if (!out.length) throw bad("LYRICS_UNPARSED", "这份 .lrc 里没有解析出带时间戳的歌词行");
  out.sort((a, b) => a.startMs - b.startMs);
  return { lines: out, timed: true, source: "lrc", offsetMs, meta };
}

function parsePlain(rows) {
  const out = [];
  for (let s of rows) {
    s = String(s).replace(/\uFEFF/g, "").trim();
    if (!s) continue;
    if (LRC_META.test(s)) continue;
    if (isSectionLine(s)) continue;
    s = s.replace(/^\s*\d{1,3}\s*[.、)．]\s+/, "").trim();   // 去掉 "1. " 这种行号
    if (!s) continue;
    out.push({ text: s, startMs: null, endMs: null });
  }
  if (!out.length) throw bad("NO_LYRICS", "没有解析出歌词行，请检查内容");
  return { lines: out, timed: false, source: "plain", offsetMs: 0, meta: {} };
}

// ------------------------------------------------------------------ 探测与对齐

/** 从 ffmpeg 的输出里取 Duration: 00:03:21.34 */
function durationFrom(text) {
  const m = /Duration:\s*(\d{1,3}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(text || ""));
  if (!m) return 0;
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

/** 素材时长：先看头里的 Duration（不解码、毫秒级返回），头里没有才退回解码一遍 */
async function probeDurationMs(file) {
  try {
    const r = await proc.run(await ffmpeg.resolve(), ["-nostdin", "-hide_banner", "-i", file], { timeoutMs: 60000 });
    const ms = durationFrom(r.stderr) || durationFrom(r.stdout);
    if (ms > 0) return ms;
  } catch (e) {
    const ms = durationFrom(e.stderr) || durationFrom(e.stdout);
    if (ms > 0) return ms;
  }
  try {
    const r = await ffmpeg.run(["-nostdin", "-hide_banner", "-i", file, "-vn", "-f", "null", NUL], { timeoutMs: 900000 });
    return durationFrom(r.stderr) || durationFrom(r.stdout);
  } catch (e2) {
    return durationFrom(e2.stderr) || durationFrom(e2.stdout);
  }
}

async function mediaDurationMs(media) {
  const known = Number(media?.duration_ms);
  if (Number.isFinite(known) && known > 0) return Math.round(known);
  if (!media?.path) throw bad("MEDIA_MISSING", "素材文件不存在");
  const ms = await probeDurationMs(media.path);
  if (ms > 0) return ms;
  const meta = await readVideoMeta(media.path).catch(() => null);
  if (meta?.durationMs > 0) return Math.round(meta.durationMs);
  throw bad("DURATION_UNKNOWN", "读不出这段素材的时长，没法把歌词和声音对齐");
}

/**
 * 找出「有人声的区间」—— 歌词对齐要用的标尺。
 *
 * 这里不做语音识别，只判断"这一段到底有没有人在唱 / 在说"；歌词文本完全按用户给的原样保留。
 *
 * 为什么不用 ffmpeg silencedetect 的写死阈值（老版本用 -35dB）：
 *   歌曲全程带伴奏，混音里几乎找不到低于 -35dB 的地方 —— 实测一首 180 秒的歌只抓到 2 段"静音"，
 *   于是整首都被当成"有人在唱"，歌词被均匀铺满全曲，连前面十几秒的纯伴奏前奏也照铺，
 *   结果就是用户看到的"歌词和歌完全对不上、越听越偏"。
 *   所以改成两步：
 *     ① 先把音频解成单声道 PCM，算出逐帧能量包络（25ms 一跳 / 150ms 一窗）；
 *     ② 用「相对响度」定门限（90 分位往下 16dB），而不是写死的绝对 dB —— 不同歌曲、不同
 *        响度母带的门限能自己跟着走。
 *   带通（220Hz~5kHz）顺手压掉鼓点与低频轰鸣：这两样在"找人声"时全是干扰。
 *
 * 但混音始终只是"猜"：鼓点、合成器铺底、掌声都可能骗过门限。
 * 要真正准，就把分离出来的**纯人声轨**当输入（bandPass:false）——见 vocal.vocalStemFor()。
 */
async function decodePcm(file, { bandPass = true, timeoutMs = 1800000 } = {}) {
  const af = bandPass ? "highpass=f=220,lowpass=f=5000" : "highpass=f=60";
  const r = await ffmpeg.run(["-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", file, "-vn", "-af", af, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
    { timeoutMs, binary: true });
  return Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout, "binary");
}

/** PCM → 逐帧 dB 包络 */
function envelopeOf(pcm, { sr = 8000, hopMs = 25, winMs = 150 } = {}) {
  const n = Math.floor(pcm.length / 2);
  const hop = Math.max(1, Math.round((sr * hopMs) / 1000));
  const win = Math.max(hop, Math.round((sr * winMs) / 1000));
  const out = [];
  for (let i = 0; i + win <= n; i += hop) {
    let sum = 0;
    for (let j = i; j < i + win; j += 1) { const v = pcm.readInt16LE(j * 2) / 32768; sum += v * v; }
    const rms = Math.sqrt(sum / win);
    out.push({ t: (i + win / 2) / sr, db: rms < 1e-6 ? -100 : 20 * Math.log10(rms) });
  }
  return out;
}

/** 分位值（入参必须已排序） */
function quantile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * 包络 → 「有人在唱」的区间（单位：秒）。
 * 门限 = 90 分位 - dropDb；相邻活动块间隔小于 minSilenceS 就并成一段（换气 / 短暂停顿不算断开），
 * 太短的碎块直接丢掉（多半是个鼓点或者口水音）。
 */
function activityRanges(env, { dropDb = 16, minSilenceS = 0.25, minLenS = 0.12, noiseDb = null } = {}) {
  if (!env.length) return { ranges: [], thresholdDb: null };
  const dbs = env.map((e) => e.db).slice().sort((a, b) => a - b);
  // 注意 Number(null) === 0 且是有限数：必须先判空，否则「没传门限」会被当成「门限 0dB」
  const thr = noiseDb != null && Number.isFinite(Number(noiseDb)) ? Number(noiseDb) : quantile(dbs, 0.9) - dropDb;
  const spans = [];
  let cur = null;
  for (const e of env) {
    if (e.db >= thr) { if (!cur) cur = { start: e.t, end: e.t }; else cur.end = e.t; }
    else if (cur) { spans.push(cur); cur = null; }
  }
  if (cur) spans.push(cur);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < minSilenceS) last.end = s.end;
    else merged.push({ ...s });
  }
  return {
    thresholdDb: +thr.toFixed(1),
    ranges: merged.filter((r) => r.end - r.start >= minLenS)
      .map((r) => ({ start: +r.start.toFixed(3), end: +r.end.toFixed(3) })),
  };
}

/**
 * 「起音点」：每唱一句，人声都会有一次能量骤升（辅音咬字 + 起音）。
 * 手算出来的时间轴只能逼近，把每行字幕再吸附到这些真实的开口瞬间上，才谈得上"对齐"。
 * 实测（《赛博街头短剧》3 分 02 秒，38 行）：落点命中率 14/38 → 30/38，位移上限 ±1.2 秒。
 *
 * @param {Array<{t:number,db:number}>} env  envelopeOf() 的包络
 * @param {Array<{start:number,end:number}>} ranges 只在这些区间里找（伴奏段不算开口）
 * @returns {Array<{t:number,f:number}>} 起音时刻（秒）与该处的能量涨幅（dB）
 */
function onsetTimes(env, ranges = [], { minFluxDb = 3.0, minGapS = 0.4, max = 400 } = {}) {
  if (!env.length) return [];
  const flux = env.map((e, i) => (i === 0 ? 0 : Math.max(0, e.db - env[i - 1].db)));
  const inRange = ranges.length
    ? (t) => ranges.some((r) => t >= r.start - 0.06 && t <= r.end)
    : () => true;
  const out = [];
  for (let i = 2; i < env.length - 1; i += 1) {
    const f = flux[i];
    if (f < minFluxDb) continue;                 // 太小的是包络抖动，不是开口
    if (f < flux[i - 1] || f < flux[i + 1]) continue;   // 只取局部极大，避免一次开口算成好几个
    if (!inRange(env[i].t)) continue;
    const last = out[out.length - 1];
    if (last && env[i].t - last.t < minGapS) { if (f > last.f) out[out.length - 1] = { t: env[i].t, f }; }
    else out.push({ t: env[i].t, f });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 把「按字数算出来」的行起点吸附到最近的起音点。
 * 位移上限 tolMs（默认 1.2 秒）：宁可不动，也不能因为吸附把整句甩到别处。
 * 同时保证逐行单调、互不重叠 —— 吸附完还要再走一遍 tidy()。
 */
function snapToOnsets(entries, onsets, { tolMs = 1200, minGapMs = 600 } = {}) {
  if (!onsets.length || !entries.length) return entries;
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const lo = i > 0 ? out[i - 1].startMs + minGapMs : 0;
    let best = null;
    let bd = Infinity;
    for (const o of onsets) {
      const ms = o.t * 1000;
      if (ms < lo) continue;
      const d = Math.abs(ms - e.startMs);
      if (d <= tolMs && d < bd) { bd = d; best = ms; }
    }
    out.push({ ...e, startMs: Math.round(best != null ? best : Math.max(e.startMs, lo)) });
  }
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].startMs < out[i - 1].startMs + minGapMs) out[i].startMs = out[i - 1].startMs + minGapMs;
  }
  return out;
}

/**
 * 探测「有人声的区间」。
 * @param {string} file          音频（或带音轨的视频）
 * @param {object} [o.bandPass]  混音要带通；已经是纯人声轨就传 false
 * @param {object} [o.noiseDb]   指定绝对门限（dB）；不传就用相对分位自动定
 * @param {object} [o.minSilenceS] 多长的安静才算断开（秒）
 * @returns {{ok:boolean, ranges:Array<{start:number,end:number}>, silence:Array, totalMs:number,
 *            note:string, voiceRatio:number, thresholdDb:(number|null), method:string}}
 */
async function speechRanges(file, { noiseDb = null, minSilenceS = 0.25, durationMs = 0, bandPass = true, dropDb = 16 } = {}) {
  const d = minSilenceS != null && Number.isFinite(Number(minSilenceS))
    ? Math.max(0.1, Math.min(3, Number(minSilenceS))) : 0.25;
  let pcm = Buffer.alloc(0);

  try {
    pcm = await decodePcm(file, { bandPass });
  } catch (e) {
    return {
      ok: false, ranges: [], silence: [], totalMs: Math.round(durationMs), voiceRatio: 0,
      thresholdDb: null, method: "none",
      note: `探测不到音轨（${String(e.message).split("\n")[0].slice(0, 80)}），改用按字数均分`,
    };
  }
  const env = envelopeOf(pcm);
  const { ranges, thresholdDb } = activityRanges(env, { dropDb, minSilenceS: d, noiseDb });
  const totalMs = Math.round(durationMs) || Math.round((env.length ? env[env.length - 1].t : 0) * 1000);
  const totalS = totalMs / 1000;
  const voiceS = ranges.reduce((s, r) => s + (r.end - r.start), 0);
  const silence = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor + 0.02) silence.push({ start: +cursor.toFixed(3), end: +r.start.toFixed(3) });
    cursor = Math.max(cursor, r.end);
  }
  if (totalS > 0 && cursor < totalS - 0.02) silence.push({ start: +cursor.toFixed(3), end: +totalS.toFixed(3) });
  const voiceRatio = totalS > 0 ? voiceS / totalS : 0;
  const silenceS = Math.max(0, totalS - voiceS);
  // 「切开了」＝ 既分出足够多段，也真的切出去像样的静音。
  // 只有 2 段、静音不到 0.8 秒，其实等于没切开 —— 那种就如实降级成按字数均分，别装作对齐过。
  const usable = ranges.length >= 2 && silenceS >= 0.8;
  const onsets = onsetTimes(env, ranges);   // 交给 align() 做「吸附到真实开口」用
  return {
    ok: usable, ranges, onsets, silence, totalMs, voiceRatio, thresholdDb, method: bandPass ? "mix" : "stem",
    note: usable
      ? `按人声活动切分：${ranges.length} 段（门限 ${thresholdDb}dB，人声占比 ${(voiceRatio * 100).toFixed(0)}%）`
      : `没抓到可用的人声分段（门限 ${thresholdDb}dB，人声占比 ${(voiceRatio * 100).toFixed(0)}%），改用按字数均分`,
  };
}

/** 一行歌词的权重：中文按 1 个字算 1，西文 / 数字按 0.6 算 */
function lineWeight(text) {
  let w = 0;
  for (const ch of String(text || "")) { if (/\s/.test(ch)) continue; w += CJK.test(ch) ? 1 : 0.6; }
  return w;
}

/** 收尾：夹在 [0, 总时长] 内、逐行单调递增、后一行不压在前一行身上 */
function tidy(entries, { totalMs, minMs = 0 }) {
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    let start = Math.max(0, Math.round(Number(e.startMs) || 0));
    if (i > 0 && start < out[i - 1].startMs + 150) start = out[i - 1].startMs + 150;
    if (start > Math.max(0, totalMs - 120)) start = Math.max(0, totalMs - 120);
    let dur = Math.max(120, Math.round(Number(e.durationMs) || 0));
    if (minMs > 0) dur = Math.max(minMs, dur);
    if (start + dur > totalMs) dur = Math.max(120, totalMs - start);
    out.push({ text: e.text, startMs: start, durationMs: dur });
  }
  for (let i = 0; i < out.length - 1; i += 1) {
    const maxDur = out[i + 1].startMs - out[i].startMs - 20;
    if (out[i].durationMs > maxDur) out[i].durationMs = Math.max(120, maxDur);
  }
  return out;
}

function fromTimed(lines, { totalMs, offsetMs, gapMs, maxMs }) {
  const out = lines.map((l, i) => {
    const next = lines[i + 1];
    let start = Number(l.startMs) + offsetMs;
    if (!Number.isFinite(start)) start = 0;
    // 同样要判空：Number(null) === 0 是有限数，会把「没有结束时间」当成「结束于 0 秒」
    const hasEnd = l.endMs != null && Number.isFinite(Number(l.endMs));
    const nextStart = next && next.startMs != null && Number.isFinite(Number(next.startMs)) ? Number(next.startMs) : null;
    let end = hasEnd ? Number(l.endMs) + offsetMs
      : (nextStart != null ? nextStart + offsetMs - gapMs : start + 4000);

    start = Math.max(0, Math.min(start, Math.max(0, totalMs - 120)));
    end = Math.min(totalMs, Math.max(start + 120, Math.min(end, start + maxMs)));
    return { text: l.text, startMs: start, durationMs: end - start };
  });
  return tidy(out, { totalMs });
}

function fromWeights(lines, { totalMs, ranges, modeUsed, offsetMs, gapMs }) {
  const timeline = modeUsed === "speech"
    ? ranges.map((r) => ({ start: r.start * 1000, end: r.end * 1000 })).filter((r) => r.end > r.start)
    : [{ start: 0, end: totalMs }];
  const span = timeline.reduce((s, r) => s + (r.end - r.start), 0) || totalMs;
  // 把「字数进度」映射到「真实时间轴」上：落在人声区间里的位置就是真实秒数
  const map = (frac) => {
    let t = Math.max(0, Math.min(1, frac)) * span;
    for (const r of timeline) {
      const len = r.end - r.start;
      if (t <= len) return r.start + t;
      t -= len;
    }
    return timeline[timeline.length - 1].end;
  };
  const weights = lines.map((l) => Math.max(1, lineWeight(l.text)));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const out = lines.map((l, i) => {
    const s = map(acc / sum);
    const e = map((acc + weights[i]) / sum);
    acc += weights[i];
    return { text: l.text, startMs: s + offsetMs, durationMs: Math.max(120, e - s - gapMs) };
  });
  return tidy(out, { totalMs });
}

/**
 * 对齐主函数。
 * @returns {{entries:Array<{text:string,startMs:number,durationMs:number}>, modeUsed:"timed"|"speech"|"even"}}
 */
function align({ lines, durationMs, ranges = [], onsets = [], mode = "auto", offsetMs = 0, gapMs = 120, minMs = 700, maxMs = 8000, snapTolMs = 1200, snapGapMs = 600 }) {
  const totalMs = Math.max(500, Math.round(Number(durationMs) || 0));
  // 注意 Number(null) === 0 且是有限数：必须先判空，否则「没时间轴的纯文本」会被误判成带时间轴
  const timedOk = lines.length > 0 && lines.every((l) => l.startMs != null && Number.isFinite(Number(l.startMs)));

  // 只有 2 段、又没切出去多少静音时，「按停顿对齐」其实等同于按字数均分 —— 这种就老实降级
  const voiceMs = Array.isArray(ranges) ? ranges.reduce((s, r) => s + (r.end - r.start) * 1000, 0) : 0;
  const speechOk = Array.isArray(ranges) && ranges.length >= 2 && (totalMs - voiceMs) >= 800;

  let modeUsed = ["timed", "speech", "even"].includes(mode) ? mode : "auto";
  if (modeUsed === "auto") modeUsed = timedOk ? "timed" : (speechOk ? "speech" : "even");
  if (modeUsed === "timed" && !timedOk) modeUsed = speechOk ? "speech" : "even";
  if (modeUsed === "speech" && !speechOk) modeUsed = "even";

  let entries = modeUsed === "timed"
    ? fromTimed(lines, { totalMs, offsetMs, gapMs, maxMs })
    : fromWeights(lines, { totalMs, ranges, modeUsed, offsetMs, gapMs });

  // 「按字数铺开」只是估：再把每行吸附到真实的起音点上，字幕才会卡在开口那一下。
  // 自带时间轴（timed）是用户给的，别动。
  let snapped = 0;
  if (modeUsed === "speech" && Array.isArray(onsets) && onsets.length) {
    const before = entries.map((e) => e.startMs);
    entries = tidy(snapToOnsets(entries, onsets, { tolMs: snapTolMs, minGapMs: snapGapMs }), { totalMs });
    snapped = entries.reduce((n, e, i) => n + (e.startMs !== before[i] ? 1 : 0), 0);
  }
  return { modeUsed, entries, snapped };
}

// ------------------------------------------------------------------ 产物文本

/** 毫秒 → LRC 时间戳 [mm:ss.cc] */
function lrcTime(ms) {
  const t = Math.max(0, Math.round(ms));
  return `[${pad(Math.floor(t / 60000))}:${pad(Math.floor((t % 60000) / 1000))}.${pad(Math.floor((t % 1000) / 10))}]`;
}

/** 对齐后的条目 → LRC 文本（音频播放器 / 剪辑软件的标准歌词格式） */
function buildLrc(entries, { title = "", artist = "" } = {}) {
  const head = [];
  if (title) head.push(`[ti:${String(title).replace(/[\[\]\r\n]/g, " ").trim()}]`);
  if (artist) head.push(`[ar:${String(artist).replace(/[\[\]\r\n]/g, " ").trim()}]`);
  head.push("[by:AI 短视频创作台]");
  head.push("[re:本地歌词对齐]");
  const body = (entries || [])
    .filter((e) => String(e?.text || "").trim())
    .map((e) => `${lrcTime(e.startMs)}${String(e.text).replace(/\s*\n\s*/g, " ").trim()}`);
  return `${head.join("\n")}\n${body.join("\n")}\n`;
}

// ------------------------------------------------------------------ 主流程

const MODE_LABEL = { timed: "歌词自带时间轴", speech: "按人声停顿对齐", asr: "语音识别逐字对齐", even: "按字数均分" };

/**
 * 把歌词和素材对齐，并把 .srt / .lrc / .ass 写成文件。
 *
 * @param {object} o
 * @param {object} o.media      音频或视频 asset（path 必填）
 * @param {string} o.lyrics     歌词原文（.lrc / .srt / 纯文本都能认）
 * @param {string} [o.mode]     auto | timed | speech | even
 * @param {number} [o.offsetMs] 整体平移（毫秒，正数=字幕整体往后）
 * @param {number} [o.gapMs]    每行末尾留白
 * @param {number} [o.minMs]    每行最短显示时长
 * @param {number} [o.maxMs]    每行最长显示时长
 * @param {number} [o.noiseDb]  绝对门限（dB）；不传就按相对响度自动定
 * @param {number} [o.minSilenceS] 多长的安静才算断开（秒，默认 0.25）
 * @param {number} [o.dropDb]   自动门限 = 90 分位 - dropDb（默认 16）
 * @param {string} [o.vocalStem] 纯人声轨路径（本机 Demucs 分离出来的）；给了就用它当标尺
 * @param {boolean}[o.useAsr]   有人声轨时是否用本机 Whisper 做逐字识别对齐（默认 true）；关掉就退回按停顿估算
 * @param {string} [o.projectId]
 * @param {string} [o.title]    LRC 的 [ti:] 标题（默认取项目名）
 * @param {boolean}[o.write]    是否落盘（默认 true）
 * @param {string} [o.reuseSrtPath] 已存在的 .srt 路径：三份原地覆盖，不再新建编号

 */
async function build(o) {
  const media = o.media;
  if (!media?.path) throw bad("PARAM_INVALID", "请先选择要配字幕的音频或视频");
  const parsed = parseLyrics(o.lyrics);
  if (parsed.lines.length > MAX_LINES) {
    throw bad("LYRICS_TOO_LONG", `歌词行数太多（${parsed.lines.length} 行，上限 ${MAX_LINES} 行）`);
  }

  const durationMs = await mediaDurationMs(media);
  const offsetMs = Number.isFinite(Number(o.offsetMs)) ? Math.round(Number(o.offsetMs)) : (parsed.offsetMs || 0);
  const gapMs = Number.isFinite(Number(o.gapMs)) ? Math.max(0, Math.min(3000, Math.round(Number(o.gapMs)))) : 120;
  const minMs = Number.isFinite(Number(o.minMs)) ? Math.max(200, Math.min(20000, Math.round(Number(o.minMs)))) : 700;
  const maxMs = Math.max(minMs, Number.isFinite(Number(o.maxMs)) ? Math.min(30000, Math.round(Number(o.maxMs))) : 8000);
  const mode = String(o.mode || "auto").toLowerCase();

  // 只有 timed 之外的模式才需要探测停顿，省一次整段解码。
  // 有分离好的人声轨就用它当标尺（干净、准）；没有才退回混音 —— 混音只是"估"，会偏。
  const stemPath = o.vocalStem && fs.existsSync(o.vocalStem) ? o.vocalStem : null;
  const needSpeech = mode === "speech" || (mode !== "timed" && !parsed.timed);
  // 门限相对"响的那一档"往下多少 dB：人声轨上停顿清楚，16dB 够用；
  // 混音上本来就挤（伴奏一直在响），收紧到 12dB 才能挤出真正的气口。
  const dropFor = (isStem) => (o.dropDb != null && Number.isFinite(Number(o.dropDb))
    ? Number(o.dropDb) : (isStem ? 16 : 12));
  let speech = needSpeech
    ? await speechRanges(stemPath || media.path, {
        noiseDb: o.noiseDb, minSilenceS: o.minSilenceS, durationMs,
        bandPass: !stemPath, dropDb: dropFor(!!stemPath),
      })
    : { ok: false, ranges: [], onsets: [], silence: [], totalMs: durationMs, voiceRatio: 0, thresholdDb: null,
        method: "none", note: "歌词自带时间轴，无需探测停顿" };
  let alignedBy = !needSpeech ? "none" : (stemPath ? "stem" : "mix");
  // 人声轨整段静音（这首歌根本没唱，是纯伴奏）或者切不出段落时别就此认输：
  // 回混音上再探一次 —— 最多也就跟"按字数均分"打平，而且会如实标成"混音探测"。
  if (needSpeech && stemPath && !speech.ok) {
    const retry = await speechRanges(media.path, {
      noiseDb: o.noiseDb, minSilenceS: o.minSilenceS, durationMs, bandPass: true, dropDb: dropFor(false),
    }).catch(() => null);
    if (retry && retry.ok) { speech = retry; alignedBy = "mix"; }
  }

  // 最强的一档：让本机 Whisper 把人声轨听一遍，拿到「每个字唱在什么时候」，
  // 再把歌词逐行贴到真正的开口处（需求报告 附录 AF）。
  // 间奏里没人唱，识别出的时间戳自然跳过它，不会被「按字数摊开」摊进间奏 ——
  // 这才是上一版歌词跟歌对不上的真正原因（整段被间奏挤偏，最多差 9 秒）。
  // 只在「有人声轨 + 歌词没自带时间轴」时用；识别不可用 / 失败 / 超时都静默退回上面的估算。
  let asrInfo = null;
  let asrEntries = null;
  if (needSpeech && stemPath && o.useAsr !== false) {
    const st = asr.status();
    if (st.available) {
      try {
        // 带歌词开头当提示词：开头几句最容易被 Whisper 整段听成幻觉（实测听成「词曲 李宗盛」），
        // 那几行拿不到时间戳就只能「按字数往前猜」—— 正是「开头几句字幕比人声慢」的老毛病。
        const asrPrompt = asr.promptFromLines(parsed.lines);
        const t = await asr.transcribe(stemPath, { prompt: asrPrompt });
        if (t?.words?.length) {
          const hit = asr.alignEntries(parsed.lines, t.words, { totalMs: durationMs, gapMs, minMs, maxMs });
          if (hit) {
            asrEntries = hit;
            asrInfo = {
              used: true, words: t.words.length, segments: (t.segments || []).length,
              cached: !!t.cached, model: path.basename(st.model || ""),
              prompt_chars: asrPrompt.length,
            };
          }
        }
      } catch (e) {
        log.warn(`语音识别对齐没跑成，退回估算：${String(e.message).split("\n")[0].slice(0, 200)}`);
      }
    }
  }

  const aligned = asrEntries
    ? { entries: asrEntries, modeUsed: "asr", snapped: 0 }   // ASR 的时间戳就是真实开口时刻，不必再吸附
    : align({
        lines: parsed.lines, durationMs, ranges: speech.ranges, onsets: speech.onsets || [],
        mode, offsetMs, gapMs, minMs, maxMs,
      });
  const { entries, modeUsed, snapped } = aligned;
  if (modeUsed === "asr") alignedBy = "stem";

  const meta = media.kind === "video" ? await readVideoMeta(media.path).catch(() => null) : null;
  const width = meta?.width || Number(media.width) || 1080;
  const height = meta?.height || Number(media.height) || 1920;
  const maxChars = subtitle.maxCharsFor(width, height);

  // keepLine：歌词一句就是一条字幕。默认的「按时间切片」会把长句拆成多条、
  // 出现只有一两个字的独立字幕（实测踩过），歌词要的是「一句跟到底」。
  const srtText = subtitle.buildSrt(entries, { maxChars, keepLine: true });
  const assText = subtitle.buildAss(entries, { width, height, maxChars, keepLine: true });
  const lrcText = buildLrc(entries, {
    title: o.title || (o.projectId ? naming.projectTitle(o.projectId) : ""),
    artist: parsed.meta?.ar || "",
  });

  let files = null;
  if (o.write !== false) {
    files = await writeFiles({
      projectId: o.projectId, srt: srtText, lrc: lrcText, ass: assText,
      reuseSrtPath: o.reuseSrtPath || null,   // 重刷历史产物时原地覆盖，不再堆新的编号
    });
  }

  const baseLabel = MODE_LABEL[modeUsed] || modeUsed;
  const modeLabel = modeUsed === "speech"
    ? `${baseLabel}（${alignedBy === "stem" ? "已分离人声" : "混音探测"}）`
    : baseLabel;
  // 可信度：歌词自带时间轴最准；分离出人声后再对齐同样靠谱；
  // 混音探测只是"估"（鼓点 / 铺底都可能骗过门限）；按字数均分是最后兜底。
  const confidence = (modeUsed === "timed" || modeUsed === "asr") ? "high"
    : modeUsed === "speech" ? (alignedBy === "stem" ? "high" : "medium")
      : "low";
  log.info(`歌词对齐完成：${parsed.lines.length} 行（${parsed.source}）→ ${modeUsed}/${alignedBy}，`
    + `${speech.note || ""} 素材 ${(durationMs / 1000).toFixed(2)}s`);
  return {
    entries, count: entries.length, durationMs, snapped,
    modeUsed, modeLabel, alignedBy, confidence,
    source: parsed.source, offsetMs, gapMs, minMs, maxMs,
    speech: {
      ok: speech.ok, count: speech.ranges.length, ranges: speech.ranges, note: speech.note,
      method: speech.method || "none", voice_ratio: Number(speech.voiceRatio || 0),
      threshold_db: speech.thresholdDb ?? null,
      onsets: Array.isArray(speech.onsets) ? speech.onsets.length : 0,
    },
    asr: asrInfo || { used: false },
    width, height, files,
    srtText, lrcText, assText,
  };
}

/**
 * 把三份字幕写进产物目录：<项目名>_字幕_0001.srt / .lrc / .ass
 * reuseSrtPath：重刷历史产物时把三份原地覆盖（保持文件名不变，避免素材库里堆一串同名字幕）。
 */
async function writeFiles({ projectId, srt, lrc, ass, reuseSrtPath = null }) {
  const dir = path.join(config.paths.exports, projectId || "noproj");
  const srtPath = reuseSrtPath || await naming.nextAssetPath(dir, { projectId, kind: "subtitle", ext: ".srt" });
  const lrcPath = srtPath.replace(/\.srt$/i, ".lrc");
  const assPath = srtPath.replace(/\.srt$/i, ".ass");
  await fsp.writeFile(srtPath, srt, "utf8");
  await fsp.writeFile(lrcPath, lrc, "utf8");
  await fsp.writeFile(assPath, ass, "utf8");
  const rel = (p) => path.relative(config.paths.data, p).split(path.sep).join("/");
  const mk = (p) => ({ path: p, name: path.basename(p), url: `/files/${rel(p)}`, bytes: Buffer.byteLength(p === srtPath ? srt : p === lrcPath ? lrc : ass, "utf8") });
  return { dir, srt: mk(srtPath), lrc: mk(lrcPath), ass: mk(assPath) };
}

/**
 * 把歌词烧成硬字幕视频（本机 ffmpeg，不占 222 的显存）。
 * 返回新建的 video asset；顺带在成片旁边写一份同名 .lrc。
 *
 * @param {object} o 同 build()，另加 { jobId, style, sink }
 * @param {object} [o.sink] 传一个对象进来，会写入 { lrc: {name,url,path} }
 */
async function burn(o) {
  if (o.media?.kind !== "video") {
    throw bad("NOT_VIDEO", "字幕要烧到画面里，请选一段视频；只有音频的话可以先生成 .lrc / .srt 下载");
  }
  const built = await build({ ...o, write: false });
  const asset = await subtitle.burn({
    jobId: o.jobId, projectId: o.projectId, shotId: o.shotId,
    video: o.media, entries: built.entries, style: o.style, keepLine: true,

  });
  if (o.sink) {
    try {
      const lrcPath = String(asset.path).replace(/\.[^.]+$/, ".lrc");
      await fsp.writeFile(lrcPath, built.lrcText, "utf8");
      const relAsset = path.relative(config.paths.data, lrcPath).split(path.sep).join("/");
      o.sink.lrc = { path: lrcPath, name: path.basename(lrcPath), url: `/files/${relAsset}` };
    } catch (e) {
      log.warn(`附带 .lrc 写入失败：${String(e.message).split("\n")[0].slice(0, 160)}`);
    }
  }
  return asset;
}

module.exports = {
  parseLyrics, align, build, burn, buildLrc, lrcTime,
  speechRanges, activityRanges, envelopeOf, decodePcm,
  probeDurationMs, mediaDurationMs, lineWeight, MODE_LABEL,
  onsetTimes, snapToOnsets,
};

