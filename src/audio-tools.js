"use strict";
/**
 * 音乐后期（本机 ffmpeg，不占显卡）。
 *
 * 「AI 创作音乐」生成的是 30-120 秒的素材，但真正要用的场景往往是：
 * 一条 3 分钟的视频要垫满 BGM、只想留副歌那 15 秒、要把两首曲子接起来、
 * 或者把音量拉齐到抖音的响度标准。这些活儿都是一次 ffmpeg 就能干完的，
 * 丢给 ComfyUI 反而要排队、还吃显存，所以在**本机**就地处理（与 WF-16L / WF-27 同一套思路）。
 *
 * 支持：多段拼接 / 裁剪 / 变速（不变调） / 接长（循环到指定时长） / 响度归一 / 淡入淡出 / 增益。
 */

const fsp = require("node:fs/promises");
const path = require("node:path");

const config = require("./config");
const log = require("./logger").scope("audio-tools");
const ffmpeg = require("./ffmpeg");
const store = require("./store");
const naming = require("./naming");

const bad = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const NUL = process.platform === "win32" ? "NUL" : "-";

/** 常见投放场景的响度目标（LUFS）：抖音/视频号按 -14 是通行做法 */
const LOUDNESS = { short_video: -14, standard: -16, youtube: -14, podcast: -16 };

/** atempo 单次只在 0.5~2 之间靠谱，超出就拆成多级串联 */
function atempoChain(speed) {
  let s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (Math.abs(s - 1) < 1e-3) return null;
  const parts = [];
  while (s > 2) { parts.push("atempo=2"); s /= 2; }
  while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(",");
}

/** 探测音频时长（秒）：跑一遍解码，从 stderr 里取最后一个 time= */
async function duration(file) {
  try {
    const r = await ffmpeg.run(["-nostdin", "-hide_banner", "-i", file, "-f", "null", NUL], { timeoutMs: 180000 });
    const text = `${r?.stderr || ""}\n${r?.stdout || ""}`;
    let max = 0;
    for (const m of text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)) {
      const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (s > max) max = s;
    }
    return max;
  } catch (e) {
    log.warn(`探测音频时长失败：${String(e.message).split("\n")[0].slice(0, 160)}`);
    return 0;
  }
}

/** 把一段或多段音频先拼成一条（多段才走这里），返回临时文件路径 */
async function concat(clips, outPath) {
  const filters = [];
  const inputs = [];
  clips.forEach((c, i) => {
    inputs.push("-i", c.path);
    filters.push(`[${i}:a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  });
  const chain = `${clips.map((_, i) => `[a${i}]`).join("")}concat=n=${clips.length}:v=0:a=1[aout]`;
  await ffmpeg.run([
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...inputs,
    "-filter_complex", `${filters.join(";")};${chain}`,
    "-map", "[aout]", "-c:a", "libmp3lame", "-b:a", "320k", "-ar", "44100", "-ac", "2", outPath,
  ], { timeoutMs: 600000 });
  return outPath;
}

/**
 * 跑一次音乐后期。
 * @param {object} o { jobId, projectId, clips:[asset], title, ops:{...} }
 * @returns {Promise<object>} 新生成的 audio 素材
 */
async function process(o) {
  const clips = (o.clips || []).filter((c) => c && c.path);
  if (!clips.length) throw bad("PARAM_INVALID", "请先选一段音乐（上传文件，或从素材库里挑一个）");
  for (const c of clips) {
    try { await fsp.access(c.path); } catch { throw bad("AUDIO_MISSING", `音乐文件不在了：${path.basename(c.path)}`); }
  }

  const op = o.ops || {};
  const trimStart = Math.max(0, Number(op.trim_start) || 0);
  const trimSeconds = Number(op.trim_seconds) > 0 ? Number(op.trim_seconds) : null;
  const targetSeconds = Number(op.target_seconds) > 0 ? Number(op.target_seconds) : null;
  const speed = Number(op.speed) > 0 ? Number(op.speed) : 1;
  const gainDb = Number.isFinite(Number(op.gain_db)) ? Math.max(-30, Math.min(20, Number(op.gain_db))) : 0;
  const fadeIn = Math.max(0, Number(op.fade_in) || 0);
  const fadeOut = Math.max(0, Number(op.fade_out) || 0);
  const normalize = op.normalize !== false;                 // 默认做响度归一（-14 LUFS）
  const loudness = LOUDNESS[op.loudness] ?? LOUDNESS.short_video;
  const bitrate = ["128k", "192k", "256k", "320k"].includes(String(op.bitrate)) ? String(op.bitrate) : "320k";

  const outDir = path.join(config.paths.exports, o.projectId || "noproj");
  await fsp.mkdir(outDir, { recursive: true });
  const outPath = await naming.nextAssetPath(outDir, { projectId: o.projectId, kind: "audio", ext: ".mp3" });

  // 1) 多段先拼成一条（单段直接用原文件，省一次转码）
  let src = clips[0].path;
  let srcDuration = 0;
  if (clips.length > 1) {
    // 多段先拼成一条：中间产物是临时的，放 renders 下，别污染素材目录
    const tmpDir = path.join(config.paths.renders, "music");
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `joined_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.mp3`);
    src = await concat(clips, tmp);
  }
  srcDuration = await duration(clips.length > 1 ? src : clips[0].path);
  if (clips.length > 1 && !srcDuration) srcDuration = 0;

  // 2) 滤镜链：裁剪 → 变速 → 增益 → 响度归一 → 淡入淡出
  const chain = [];
  if (trimStart || trimSeconds) {
    const end = trimSeconds ? `:end=${(trimStart + trimSeconds).toFixed(3)}` : "";
    chain.push(`atrim=start=${trimStart.toFixed(3)}${end}`, "asetpts=N/SR/TB");
  }
  const tempo = atempoChain(speed);
  if (tempo) chain.push(tempo);
  if (gainDb) chain.push(`volume=${gainDb}dB`);
  if (normalize) chain.push(`loudnorm=I=${loudness}:TP=-1.5:LRA=11`);

  // 算出「经过上面这些处理之后的长度」，淡出要靠它定位
  let shownDuration = srcDuration ? Math.max(0, srcDuration - trimStart) : 0;
  if (trimSeconds) shownDuration = Math.min(shownDuration || trimSeconds, trimSeconds);
  if (tempo && shownDuration) shownDuration = shownDuration / speed;
  if (targetSeconds) shownDuration = targetSeconds;

  if (fadeIn) chain.push(`afade=t=in:st=0:d=${Math.min(fadeIn, Math.max(0.1, shownDuration || fadeIn)).toFixed(3)}`);
  if (fadeOut && shownDuration) {
    const st = Math.max(0, shownDuration - fadeOut);
    chain.push(`afade=t=out:st=${st.toFixed(3)}:d=${Math.min(fadeOut, shownDuration).toFixed(3)}`);
  }

  const filter = `[0:a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${chain.length ? "," + chain.join(",") : ""}[aout]`;
  // 要接长就循环输入（-stream_loop -1），再用 -t 钉在目标时长上
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
  if (targetSeconds) args.push("-stream_loop", "-1");
  args.push("-i", src, "-filter_complex", filter, "-map", "[aout]",
    "-c:a", "libmp3lame", "-b:a", bitrate, "-ar", "44100", "-ac", "2");
  if (targetSeconds) args.push("-t", String(targetSeconds));
  args.push(outPath);

  const est = Math.max(30, Math.round((targetSeconds || shownDuration || 60) * 2) + 60);
  await ffmpeg.run(args, { timeoutMs: est * 1000 });
  const st = await fsp.stat(outPath).catch(() => null);
  if (!st?.size) throw bad("EDIT_EMPTY", "音频处理没有产出文件，请换个参数再试");

  const finalDuration = await duration(outPath);
  const rel = path.relative(config.paths.data, outPath).split(path.sep).join("/");
  const asset = store.asset.create({
    job_id: o.jobId || null, project_id: o.projectId || null, shot_id: o.shotId || null,
    kind: "audio", path: outPath, url: `/files/${rel}`, mime: "audio/mpeg",
    width: null, height: null, duration_ms: finalDuration ? Math.round(finalDuration * 1000) : null,
    fps: null, has_audio: 1, watermark: 0, size_bytes: st.size,
    meta: {
      engine: "ffmpeg", workflow_id: "WF-35",
      source: { clips: clips.map((c) => c.id), files: clips.map((c) => path.basename(c.path)) },
      ops: {
        trim_start: trimStart || 0, trim_seconds: trimSeconds, speed, gain_db: gainDb,
        target_seconds: targetSeconds, fade_in: fadeIn, fade_out: fadeOut,
        normalize, loudness: normalize ? loudness : null, bitrate,
      },
      note: `本机处理：${planText(op)}`,
    },
  });
  log.info(`音乐后期完成：${clips.length} 段 → ${path.basename(outPath)}（${finalDuration.toFixed(1)}s，${planText(op)}）`);
  return asset;
}

/** 给人看的操作说明（响应与素材 meta 都用它） */
function planText(op = {}) {
  const ops = [];
  if (Number(op.trim_start) > 0 || Number(op.trim_seconds) > 0) ops.push("裁剪");
  if (Number(op.speed) > 0 && Math.abs(Number(op.speed) - 1) > 1e-3) ops.push(`变速 ${Number(op.speed)}x`);
  if (Number(op.target_seconds) > 0) ops.push(`接长到 ${Number(op.target_seconds)} 秒`);
  if (Number(op.fade_in) > 0) ops.push(`淡入 ${Number(op.fade_in)}s`);
  if (Number(op.fade_out) > 0) ops.push(`淡出 ${Number(op.fade_out)}s`);
  if (op.normalize !== false) ops.push(`响度归一 ${LOUDNESS[op.loudness] ?? LOUDNESS.short_video} LUFS`);
  if (Number.isFinite(Number(op.gain_db)) && Number(op.gain_db) !== 0) ops.push(`增益 ${Number(op.gain_db)}dB`);
  return ops.length ? ops.join(" + ") : "原样复制";
}

module.exports = { process, planText, duration, LOUDNESS, atempoChain };