"use strict";
/**
 * 本机成片合成：把一条音轨挂到一段视频上（配音 / 换音轨 / 与原声混音）。
 *
 * 为什么放本机（详见 ffmpeg.js 顶部与需求报告 附录 H.4）：
 * 222 上那套 GetVideoComponents → CreateVideo 会把整段视频的所有帧解码进内存，
 * 8 分 55 秒的 720×1280 就要 ~95GB，直接被内核 OOM Killer 杀掉。
 * 而这件事在容器层面只是「复制视频流 + 重编码音轨」：不碰 GPU、不解画面，
 * 8 分钟的视频 7 秒跑完，画质零损失（视频流 -c:v copy 原样搬运）。
 *
 * 时间轴对齐规则（与改造前 WF-26 的语义一致，只换实现）：
 *   成品音轨长度永远等于视频长度 —— 旁白比画面短就补静音、比画面长就截断。
 */

const fsp = require("node:fs/promises");
const path = require("node:path");

const config = require("./config");
const log = require("./logger").scope("mux");
const ffmpeg = require("./ffmpeg");
const store = require("./store");
const { readVideoMeta } = require("./mp4");
const naming = require("./naming");

const bad = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

const clampDb = (v, d) => (Number.isFinite(Number(v)) ? Math.max(-60, Math.min(20, Math.round(Number(v)))) : d);
const gain = (db) => `${db}dB`;

/** 产物文件名：保留可读性（在剪映里认得出是哪一段），只清掉会惹麻烦的字符 */
function safeStem(name) {
  const stem = String(name || "").replace(/\.[^.]+$/, "");
  return stem.replace(/[^\w.\u4e00-\u9fa5-]+/g, "_").slice(0, 60) || "video";
}

/** 在目标目录里挑一个不重名的文件名 */
async function uniquePath(dir, stem, ext = ".mp4") {
  await fsp.mkdir(dir, { recursive: true });
  for (let i = 0; i < 200; i += 1) {
    const full = path.join(dir, i === 0 ? `${stem}${ext}` : `${stem}-${i}${ext}`);
    try { await fsp.access(full); } catch { return full; }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/** 视频时长：优先用素材库里已探测好的值，缺了才读文件（只读头尾两段，不解码） */
async function videoSeconds(asset) {
  const ms = Number(asset?.duration_ms);
  if (Number.isFinite(ms) && ms > 0) return ms / 1000;
  const meta = asset?.path ? await readVideoMeta(asset.path).catch(() => null) : null;
  if (meta?.durationMs > 0) return meta.durationMs / 1000;
  throw bad("DURATION_UNKNOWN", "读不出这段视频的时长，没法让配音和画面对齐；请换一段素材或重新上传");
}

async function mustExist(file, code, what) {
  try { await fsp.access(file); } catch { throw bad(code, `${what}不存在：${file}`); }
}

/**
 * 这段素材**本身有没有音轨**（以文件实际探测为准，探测不到才回落到素材库的记录）。
 *
 * 为什么单独抽出来：Wan 2.2（WF-07 / WF-08 等）是**无声引擎**，产物根本没有音轨；
 * 而「原声对齐 / 配音」都要求先有原声，不能靠素材库字段瞎猜。
 */
async function hasAudioTrack(video) {
  if (!video?.path) return false;
  const meta = await readVideoMeta(video.path).catch(() => null);
  return meta ? !!meta.hasAudio : !!video.has_audio;
}

/**
 * 真的去合轨。
 * @param {object} o
 * @param {object} o.video            源视频 asset（path 必填，duration_ms 可选）
 * @param {object} o.audio            配音音频 asset（path 必填）
 * @param {string} o.outPath          产物绝对路径
 * @param {boolean} [o.keepOriginal]  视频本来有原声时，是否压低了当背景保留
 * @param {number}  [o.originalDb]    原声音量（dB，负数=压低）
 * @param {number}  [o.voiceDb]       配音音量（dB）
 */
async function muxAudioIntoVideo(o) {
  const cfg = config.mux;
  if (!o.video?.path) throw bad("PARAM_INVALID", "缺少源视频");
  // audio 允许为空：那是「只压原声、不加人声」的用法（见 regain()）
  const hasVoice = !!o.audio?.path;
  await mustExist(o.video.path, "VIDEO_MISSING", "源视频文件");
  if (hasVoice) await mustExist(o.audio.path, "AUDIO_MISSING", "配音文件");

  const seconds = await videoSeconds(o.video);
  const dur = seconds.toFixed(3);
  const srcMeta = await readVideoMeta(o.video.path).catch(() => null);
  // 以文件实际探测为准，探测不到才回落到素材库里的记录
  const hasOriginal = srcMeta ? !!srcMeta.hasAudio : !!o.video.has_audio;
  if (!hasVoice && !hasOriginal) throw bad("NO_AUDIO", "源视频没有音轨，没法做原声对齐");
  const keepOriginal = o.keepOriginal !== false && hasOriginal;
  const voiceDb = clampDb(o.voiceDb, 0);
  const originalDb = clampDb(o.originalDb, -14);

  // 旁白放在 audio2：amix 以最长的时间轴为准，不足的部分自动补静音；
  // 再用 apad + -t 把音轨严格钉在视频长度上（apad 不能无限补，否则 ffmpeg 永远不结束）。
  const filter = !hasVoice
    ? `[0:a:0]volume=${gain(originalDb)}[aout]`
    : keepOriginal
      ? `[0:a:0]volume=${gain(originalDb)}[orig];[1:a:0]volume=${gain(voiceDb)}[voice];` +
        `[orig][voice]amix=inputs=2:duration=longest:normalize=0,apad=whole_dur=${dur}[aout]`
      : `[1:a:0]volume=${gain(voiceDb)},apad=whole_dur=${dur}[aout]`;

  await fsp.mkdir(path.dirname(o.outPath), { recursive: true });
  const inputs = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", o.video.path];
  if (hasVoice) inputs.push("-i", o.audio.path);
  const render = [
    "-filter_complex", filter,
    "-map", "0:v:0", "-map", "[aout]",
    "-c:a", "aac", "-b:a", cfg.audioBitrate, "-ar", String(cfg.sampleRate), "-ac", String(cfg.channels),
    "-t", dur, "-movflags", "+faststart",
  ];
  const timeoutMs = Math.max(180000, Math.round(seconds * 2000) + 180000);

  let transcoded = false;
  try {
    // 首选：视频流原样复制 —— 不重新编码，画质和源素材完全一致，也最快
    await ffmpeg.run([...inputs, "-c:v", "copy", ...render, o.outPath], { timeoutMs });
  } catch (e) {
    // 源不是 mp4 友好的编码（VP9 / AV1 / 特殊 profile）时，退回重编码，别让用户卡在这
    log.warn(`视频流直拷失败，改用 H.264 重编码：${String(e.message).split("\n")[0].slice(0, 200)}`);
    transcoded = true;
    await ffmpeg.run([...inputs, "-c:v", "libx264", "-preset", "veryfast", "-crf", String(cfg.fallbackCrf),
      "-pix_fmt", "yuv420p", ...render, o.outPath], { timeoutMs });
  }

  const st = await fsp.stat(o.outPath);
  if (!st.size) throw bad("MUX_EMPTY", "合轨没有产出文件，请重试");

  const outMeta = await readVideoMeta(o.outPath).catch(() => null);
  const resolved = {
    outPath: o.outPath,
    sizeBytes: st.size,
    width: outMeta?.width || srcMeta?.width || o.video.width || null,
    height: outMeta?.height || srcMeta?.height || o.video.height || null,
    fps: outMeta?.fps || srcMeta?.fps || o.video.fps || null,
    durationMs: outMeta?.durationMs || Math.round(seconds * 1000),
    keepOriginal, hasOriginal, originalDb, voiceDb, transcoded,
  };
  log.info(`合轨完成：${path.basename(o.outPath)} ${resolved.width}x${resolved.height} ` +
    `${(resolved.durationMs / 1000).toFixed(2)}s ${(st.size / 1048576).toFixed(1)}MB` +
    `（原声${keepOriginal ? `保留 ${originalDb}dB` : "不保留"}${hasVoice ? `，配音 ${voiceDb}dB` : "，无人声"}，视频流${transcoded ? "重编码" : "直拷"}）`);
  return resolved;
}

/**
 * 配音合成的完整一步：合轨 → 落一条带音轨的视频素材。
 *
 * @param {object} o
 * @param {object} o.video       源视频 asset
 * @param {object} o.audio       配音音频 asset（通常来自 tts.synthesizeToAsset）
 * @param {string} [o.jobId]     归属任务（任务中心能追溯到）
 * @param {string} [o.projectId]
 * @param {string} [o.shotId]
 * @param {boolean}[o.keepOriginal=true]
 * @param {number} [o.originalDb=-14]
 * @param {number} [o.voiceDb=0]
 * @returns {Promise<object>} 新建的 video asset
 */
async function dub(o) {
  if (!o.video?.id) throw bad("PARAM_INVALID", "缺少源视频素材");
  if (!o.audio?.id) throw bad("PARAM_INVALID", "缺少配音音频素材");

  const outDir = path.join(config.paths.exports, o.projectId || "noproj");
  const outPath = await naming.nextAssetPath(outDir, { projectId: o.projectId, kind: "video", ext: ".mp4" });

  const r = await muxAudioIntoVideo({
    video: o.video, audio: o.audio, outPath,
    keepOriginal: o.keepOriginal, originalDb: o.originalDb, voiceDb: o.voiceDb,
  });

  const rel = path.relative(config.paths.data, outPath).split(path.sep).join("/");
  const asset = store.asset.create({
    job_id: o.jobId || null, project_id: o.projectId || null, shot_id: o.shotId || null,
    kind: "video", path: outPath, url: `/files/${rel}`, mime: "video/mp4",
    width: r.width, height: r.height, duration_ms: r.durationMs, fps: r.fps,
    has_audio: true, watermark: false, size_bytes: r.sizeBytes,
    meta: {
      engine: "local",
      workflow_id: "WF-26",
      source: { video: o.video.id, audio: o.audio.id, video_filename: path.basename(o.video.path || "") },
      keep_original: r.keepOriginal,          // 实际生效的结果（源本身没音轨时一定是 false）
      had_original_audio: r.hasOriginal,
      original_volume_db: r.originalDb,
      voice_volume_db: r.voiceDb,
      note: r.transcoded
        ? "本机合成（源编码不适合 mp4，已重编码为 H.264）"
        : "本机合成：视频流未重新编码，画质与源素材一致",
    },
  });
  return asset;
}

/**
 * 只统一原声（不加人声）：把这一镜的模型原声压到指定音量档。
 *
 * 为什么需要：「带声音」时，有台词的镜头会被合成成「原声 -14dB + 人声 0dB」；没有台词的镜头
 * 如果原样不动，就还是满档原声、也没有人声 —— 一条片子里两种处理混着来，用户听到的就是
 * 「几种混音叠在一起、音量忽大忽小」。所以没台词的镜头也要过一遍这里，把原声压到同一档。
 *
 * 源视频**本身就没有音轨**时（Wan 2.2 这类无声引擎的产物）直接返回 null：没有原声可压，
 * 而且「全程无声」本来就是一致的、不存在几种混音。早期版本缺这个判断，静音镜头会报
 * 「源视频没有音轨，没法做原声对齐」并把任务中心那条任务标红（已修）。
 *
 * @returns {Promise<object|null>} 对齐后的新素材；无需 / 无法对齐时返回 null
 */
async function regain(o) {
  if (!o.video?.id) throw bad("PARAM_INVALID", "缺少源视频素材");
  if (!(await hasAudioTrack(o.video))) {
    log.info(`原声对齐跳过：${path.basename(o.video.path || "video")} 本身没有音轨（无声引擎产物，全程无声即一致）`);
    return null;
  }
  const outDir = path.join(config.paths.exports, o.projectId || "noproj");
  const outPath = await naming.nextAssetPath(outDir, { projectId: o.projectId, kind: "video", ext: ".mp4" });

  const r = await muxAudioIntoVideo({ video: o.video, audio: null, outPath, originalDb: o.originalDb });

  const rel = path.relative(config.paths.data, outPath).split(path.sep).join("/");
  const asset = store.asset.create({
    job_id: o.jobId || null, project_id: o.projectId || null, shot_id: o.shotId || null,
    kind: "video", path: outPath, url: `/files/${rel}`, mime: "video/mp4",
    width: r.width, height: r.height, duration_ms: r.durationMs, fps: r.fps,
    has_audio: true, watermark: false, size_bytes: r.sizeBytes,
    meta: {
      engine: "local",
      workflow_id: "WF-26",
      source: { video: o.video.id, video_filename: path.basename(o.video.path || "") },
      original_volume_db: r.originalDb,
      note: "本机原声对齐：这一镜没有台词，只把模型原声压到与配音镜头同一音量档，避免成片里音量忽大忽小",
    },
  });
  log.info(`原声对齐完成：${path.basename(outPath)} ${r.width}x${r.height} `
    + `${(r.durationMs / 1000).toFixed(2)}s（原声压到 ${r.originalDb}dB，无人声）`);
  return asset;
}

/** 给能力自检 / 诊断接口用 */
async function status() {
  const ff = await ffmpeg.status();
  return { available: !!ff.available, ffmpeg: ff, note: "配音 / 换音轨在本机用 ffmpeg 完成，不占用 222 的 GPU" };
}

module.exports = { dub, regain, muxAudioIntoVideo, hasAudioTrack, status, videoSeconds, safeStem, uniquePath };