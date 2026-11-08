"use strict";
/**
 * 素材压缩：把音频 / 视频压到「指定大小以内」（本机 ffmpeg，需求报告 附录 AG）。
 *
 * 为什么放在本机跑：和配音合成、烧字幕一样，压缩是纯 I/O（解码 → 重编码），
 * 丢给 222 只会白占一张显卡和一条队列；本机 ffmpeg 压一条 3 分钟的 720p 视频约 7 秒。
 *
 * 视频走**两遍 ABR（two-pass）**：第一遍只统计、第二遍才出片，按目标大小精确分配码率。
 * 这里的目标是「大小可预期」而不是「画质最好」—— 平台限 10MB 时，用户要的是能传上去。
 * 音频走单遍 CBR（mp3），同样按目标大小反算码率。
 *
 * 产物按 <项目名称>_视频_0001.mp4 / <项目名称>_音频_0001.mp3 落盘，在素材库里登记成**新素材**，
 * 原素材一个字节都不动（压坏了 / 压糊了还能退回去重新压一版）。
 */

const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");

const config = require("./config");
const log = require("./logger").scope("compress");
const ffmpeg = require("./ffmpeg");
const naming = require("./naming");
const store = require("./store");
const { readVideoMeta } = require("./mp4");

const bad = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

const MB = 1048576;
const COMPRESSIBLE = ["video", "audio"];

/** 预设：都是「按目标大小压」，视频 / 音频通用 */
const PRESETS = [
  { id: "m5", label: "5MB 以内（微信 / 朋友圈）", targetMB: 5 },
  { id: "m10", label: "10MB 以内（抖音 / 快手 高清上传）", targetMB: 10 },
  { id: "m25", label: "25MB 以内（微信发送）", targetMB: 25 },
  { id: "m50", label: "50MB 以内（通用小体积）", targetMB: 50 },
];
const DEFAULT_TARGET_MB = 10;

/** 视频码率低于这个数，画面就没法看了 —— 用它反推「这个目标是不是太小」 */
const MIN_VIDEO_KBPS = 120;
const MIN_AUDIO_KBPS = 48;
const MAX_AUDIO_KBPS = 320;

/** ABR 实际落盘通常比目标略小；留 4% 余量，保证「10MB 以内」说的是落盘后的大小 */
const BUDGET_RATIO = 0.96;

function presets() {
  return PRESETS.map((p) => ({ ...p }));
}

/** 素材时长（秒）：先看素材表，再读容器，最后兜底用 ffmpeg 打印的 Duration */
async function mediaSeconds(asset) {
  const known = Number(asset?.duration_ms) > 0 ? Number(asset.duration_ms) / 1000 : 0;
  if (known) return known;
  const meta = await readVideoMeta(asset.path).catch(() => null);
  if (meta?.durationMs) return meta.durationMs / 1000;
  // ffmpeg 没有输出文件时会「报错退出」，但 Duration 就在 stderr 里（proc.run 把 stderr 挂在 error 上）
  const err = await ffmpeg.run(["-nostdin", "-hide_banner", "-i", asset.path]).catch((e) => e);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(err?.stderr || ""));
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * 算一份压缩方案（不落盘）。前端「预览要压成多大」和后端真正压都用它，保证口径一致。
 *
 * @param {object} o
 * @param {object} o.asset       源素材（video / audio）
 * @param {number} [o.targetMB]  目标大小（MB，默认 10）
 * @param {number} [o.maxHeight] 视频输出高度上限（0=保持原样）
 * @param {number} [o.audioKbps] 视频里的音轨码率（默认 128；源没音轨就自动为 0）
 * @param {string} [o.preset]    预设 id（m5 / m10 / m25 / m50）
 */
async function plan({ asset, targetMB, maxHeight = 0, audioKbps = 0, preset = null }) {
  if (!asset?.id) throw bad("PARAM_INVALID", "缺少要压缩的素材");
  if (!COMPRESSIBLE.includes(asset.kind)) {
    throw bad("PARAM_INVALID", `只有音频 / 视频能压缩（当前是 ${asset.kind}）`);
  }
  if (!asset.path || !fs.existsSync(asset.path)) {
    throw bad("ASSET_FILE_MISSING", "源文件已经不在磁盘上了，没法压缩", 404);
  }

  const pre = presets().find((p) => p.id === preset) || null;
  const mb = Number(targetMB) > 0 ? Number(targetMB) : (pre?.targetMB || DEFAULT_TARGET_MB);
  if (!(mb >= 1 && mb <= 4096)) throw bad("PARAM_INVALID", "目标大小请填 1～4096 MB");

  const seconds = await mediaSeconds(asset);
  if (!(seconds > 0.5)) {
    throw bad("DURATION_UNKNOWN", "读不出这个素材的时长，没法按目标大小算码率；先在素材库里预览一次再试");
  }
  const srcBytes = Number(asset.size_bytes) > 0 ? Number(asset.size_bytes) : fs.statSync(asset.path).size;
  const targetBytes = Math.round(mb * MB);
  const isAudio = asset.kind === "audio";

  // 源里到底有没有音轨：素材表没记就现场读一次（决定码率预算怎么分）
  let hasAudio = true;
  if (!isAudio) {
    hasAudio = asset.has_audio != null ? !!asset.has_audio
      : !!(await readVideoMeta(asset.path).catch(() => null))?.hasAudio;
  }
  const wantAudio = isAudio ? 0 : (Number(audioKbps) > 0 ? Math.round(Number(audioKbps)) : 128);
  const ak = isAudio ? 0 : (hasAudio ? wantAudio : 0);

  const budgetKbps = Math.round((targetBytes * BUDGET_RATIO) * 8 / seconds / 1000);
  const minAudioKbps = isAudio ? MIN_AUDIO_KBPS : ak;

  if (isAudio) {
    const kbps = Math.max(MIN_AUDIO_KBPS, Math.min(MAX_AUDIO_KBPS, budgetKbps));
    const minMB = (MIN_AUDIO_KBPS * seconds / 8) / 1024 * 1.04;
    if (budgetKbps < MIN_AUDIO_KBPS) {
      throw bad("TARGET_TOO_SMALL",
        `${seconds.toFixed(0)} 秒的音频压到 ${mb} MB，码率只有 ${budgetKbps} kbps，声音会碎。这个长度至少要 ${minMB.toFixed(1)} MB。`);
    }
    return {
      assetId: asset.id, kind: "audio", isAudio: true, seconds, srcBytes, targetMB: mb, targetBytes,
      budgetKbps, videoKbps: 0, audioKbps: kbps, hasAudio: true,
      srcWidth: null, srcHeight: null, outHeight: null, scale: null,
      alreadySmall: srcBytes <= targetBytes, minMB,
    };
  }

  const vk = budgetKbps - ak;
  const minMB = ((MIN_VIDEO_KBPS + minAudioKbps) * seconds / 8) / 1024 * 1.04;
  if (vk < MIN_VIDEO_KBPS) {
    throw bad("TARGET_TOO_SMALL",
      `${seconds.toFixed(0)} 秒的视频压到 ${mb} MB，画面码率只剩 ${Math.max(0, vk)} kbps`
      + (ak > 0 ? `（音轨 ${ak} kbps 先占掉一截）` : "") + `，会糊成一片。`
      + `这个长度建议至少 ${minMB.toFixed(1)} MB。`);
  }

  const srcW = Number(asset.width) || 0;
  const srcH = Number(asset.height) || 0;
  let outHeight = 0;
  if (Number(maxHeight) > 0) {
    outHeight = Math.round(Number(maxHeight));
    if (srcH && outHeight >= srcH) outHeight = 0;      // 本来就比目标矮，别放大
  }
  const scale = outHeight && srcH && outHeight < srcH
    ? `scale=-2:${outHeight - (outHeight % 2)}` : null;

  return {
    assetId: asset.id, kind: "video", isAudio: false, seconds, srcBytes, targetMB: mb, targetBytes,
    budgetKbps, videoKbps: Math.round(vk), audioKbps: ak, hasAudio,
    srcWidth: srcW || null, srcHeight: srcH || null,
    outHeight: scale ? outHeight : (srcH || null), scale,
    alreadySmall: srcBytes <= targetBytes, minMB,
  };
}

/** 清掉两遍编码留下的 -0.log / .mbtree（不删会堆在产物目录里） */
async function cleanPassLog(dir, base) {
  try {
    const names = await fsp.readdir(dir);
    await Promise.all(names.filter((n) => n.startsWith(base))
      .map((n) => fsp.rm(path.join(dir, n), { force: true }).catch(() => null)));
  } catch { /* 清不掉就算了，别影响出片 */ }
}

/**
 * 真正执行压缩：两遍 ABR → 落盘 → 登记成新素材。
 *
 * @param {object} o
 * @param {object} o.asset
 * @param {string} [o.jobId]      归属任务（任务中心能追溯到）
 * @param {number} [o.targetMB]
 * @param {number} [o.maxHeight]
 * @param {number} [o.audioKbps]
 * @param {string} [o.preset]
 * @param {boolean}[o.force]      源文件本来就比目标小的时候，是否照样压一遍
 * @returns {Promise<object>} 新建的 asset
 */
async function compress(o) {
  const p = await plan(o);
  if (p.alreadySmall && !o.force) {
    throw bad("ALREADY_SMALL",
      `这个素材只有 ${(p.srcBytes / MB).toFixed(2)} MB，已经比目标 ${p.targetMB} MB 小了，不用压。`
      + "（确实想重压一遍就勾上「仍然压缩」）");
  }

  const outDir = path.join(config.paths.exports, o.projectId || o.asset.project_id || "noproj");
  const ext = p.isAudio ? ".mp3" : ".mp4";
  const outPath = await naming.nextAssetPath(outDir, {
    projectId: o.projectId || o.asset.project_id || null, kind: p.kind, ext,
  });
  const outName = path.basename(outPath);
  const logBase = `._pass_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const timeoutMs = Math.max(300000, Math.round(p.seconds * 4000) + 300000);
  const head = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", o.asset.path];

  try {
    if (p.isAudio) {
      await ffmpeg.run([...head, "-vn", "-c:a", "libmp3lame", "-b:a", `${p.audioKbps}k`,
        "-ar", "44100", "-ac", "2", outName], { timeoutMs, cwd: outDir });
    } else {
      const venc = ["-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-b:v", `${p.videoKbps}k`];
      const vf = p.scale ? ["-vf", p.scale] : [];
      // 第一遍：只统计复杂度（-f null - 不写文件），产出 x264 的码率分配表
      await ffmpeg.run([...head, ...vf, ...venc, "-pass", "1", "-passlogfile", logBase, "-an", "-f", "null", "-"],
        { timeoutMs, cwd: outDir });
      const pass2 = async (vk) => {
        const args = [...head, ...vf, "-c:v", "libx264", "-preset", "slow", "-profile:v", "high",
          "-pix_fmt", "yuv420p", "-b:v", `${vk}k`, "-pass", "2", "-passlogfile", logBase];
        if (p.audioKbps > 0) args.push("-c:a", "aac", "-b:a", `${p.audioKbps}k`, "-ac", "2", "-ar", "44100");
        else args.push("-an");
        args.push("-movflags", "+faststart", outName);
        await ffmpeg.run(args, { timeoutMs, cwd: outDir });
      };
      await pass2(p.videoKbps);
      // 万一还是超了（源太复杂 / 有超大关键帧），按实际大小折一次码率再压一遍 —— 失败概率低，但兜住更稳
      for (let i = 0; i < 2; i += 1) {
        const st = await fsp.stat(outPath);
        if (st.size <= p.targetBytes) break;
        const next = Math.max(MIN_VIDEO_KBPS, Math.round(p.videoKbps * (p.targetBytes / st.size) * 0.92));
        log.warn(`压缩结果 ${(st.size / MB).toFixed(2)}MB 超过目标 ${p.targetMB}MB，降到 ${next}kbps 重压一遍`);
        p.videoKbps = next;
        await pass2(next);
      }
    }
  } finally {
    await cleanPassLog(outDir, logBase);
  }

  const st = await fsp.stat(outPath).catch(() => null);
  if (!st || !st.size) throw bad("COMPRESS_EMPTY", "压缩没有产出文件，请重试");
  const meta = p.isAudio ? null : await readVideoMeta(outPath).catch(() => null);

  const rel = path.relative(config.paths.data, outPath).split(path.sep).join("/");
  const ratio = p.srcBytes > 0 ? st.size / p.srcBytes : 1;
  const asset = store.asset.create({
    job_id: o.jobId || null, project_id: o.projectId || o.asset.project_id || null, shot_id: null,
    kind: p.kind, path: outPath, url: `/files/${rel}`,
    mime: p.isAudio ? "audio/mpeg" : "video/mp4",
    width: p.isAudio ? null : (meta?.width || null),
    height: p.isAudio ? null : (meta?.height || null),
    duration_ms: Math.round((meta?.durationMs ? meta.durationMs / 1000 : p.seconds) * 1000),
    fps: meta?.fps ?? null,
    has_audio: p.isAudio ? true : !!(meta?.hasAudio ?? p.hasAudio),
    watermark: false, size_bytes: st.size,
    meta: {
      engine: "local",
      workflow_id: "WF-36L",
      source: { asset: p.assetId, filename: path.basename(o.asset.path || "") },
      compressed: {
        from_bytes: p.srcBytes, to_bytes: st.size, ratio: Number(ratio.toFixed(3)),
        target_mb: p.targetMB, target_bytes: p.targetBytes,
        within_target: st.size <= p.targetBytes,
        video_kbps: p.isAudio ? null : p.videoKbps,
        audio_kbps: p.audioKbps,
        height: p.isAudio ? null : (meta?.height || p.outHeight || null),
        seconds: Math.round(p.seconds * 100) / 100,
      },
      note: st.size <= p.targetBytes
        ? `本机两遍压缩：${(p.srcBytes / MB).toFixed(1)}MB → ${(st.size / MB).toFixed(2)}MB（目标 ${p.targetMB}MB 以内），无水印，可直接上传`
        : `本机压缩：${(p.srcBytes / MB).toFixed(1)}MB → ${(st.size / MB).toFixed(2)}MB；源太复杂，没能压进 ${p.targetMB}MB，可再降一档目标或降分辨率重压`,
    },
  });
  log.info(`压缩完成：${outName} ${(p.srcBytes / MB).toFixed(1)}MB → ${(st.size / MB).toFixed(2)}MB`
    + `（${p.isAudio ? `音频 ${p.audioKbps}kbps` : `视频 ${p.videoKbps}kbps + 音频 ${p.audioKbps}kbps`}）`);
  return asset;
}

module.exports = { compress, plan, presets, PRESETS, DEFAULT_TARGET_MB };