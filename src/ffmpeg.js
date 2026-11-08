"use strict";
/**
 * 本机 ffmpeg 的定位与调用。
 *
 * 为什么配音/合轨要搬回本机跑（需求报告 附录 H「长视频 OOM 复盘」）：
 * 原先在 222 上走的是 GetVideoComponents → CreateVideo 这条链，前者会把整段视频的
 * **所有帧**一次性解码进内存：8 分 55 秒的 720×1280 = 8569 帧，光画面就 ~95GB，
 * 直接把内核 OOM Killer 招来了（同一个工作流 5 秒的短片却完全正常）。
 * 而「给视频加/换一条音轨」在容器层面只是复制视频流 + 重编码音轨：不碰 GPU、
 * 不解画面，同一段视频 7 秒跑完，8 分钟的长视频也照样能出片，显存留给真正的生成任务。
 *
 * ffmpeg 来源（按优先级）：
 *   config.runtime.ffmpegPath → config.mux.ffmpegPath → AVS_FFMPEG → PATH 里的 ffmpeg
 *   → Python 的 imageio-ffmpeg 自带的完整版 ffmpeg.exe。
 */

const fs = require("node:fs");
const path = require("node:path");

const config = require("./config");
const log = require("./logger").scope("ffmpeg");
const proc = require("./proc");
const python = require("./python");

const PY_SCRIPT = "import imageio_ffmpeg,sys;sys.stdout.write('AVS_FFMPEG:'+imageio_ffmpeg.get_ffmpeg_exe())";
const PY_MARKER = "AVS_FFMPEG:";

let cache = null;   // { ok:true, exe, source } | { ok:false, tried }

function missingError(tried) {
  return Object.assign(new Error(
    "本机没有可用的 ffmpeg，暂时无法合成带声音的视频。请在任意 Python 里执行 " +
    "pip install imageio-ffmpeg，或在 config.json 的 runtime.ffmpegPath 里指向 ffmpeg.exe。" +
    (tried?.length ? `已尝试：${tried.join("；")}` : "")),
    { code: "FFMPEG_MISSING", status: 500 });
}

/** 确认某个路径（或 PATH 里的名字）真的是 ffmpeg */
async function probe(exe, source, tried) {
  if (!exe) return null;
  if (/[\\/]/.test(exe) && !fs.existsSync(exe)) { tried.push(`${exe}（文件不存在）`); return null; }
  try {
    const r = await proc.run(exe, ["-hide_banner", "-version"], { timeoutMs: 20000 });
    if (/ffmpeg version/i.test(r.stdout + r.stderr)) return { exe, source };
    tried.push(`${exe}（不像 ffmpeg）`);
  } catch (e) {
    tried.push(`${exe}（${String(e.message).split("\n")[0].slice(0, 70)}）`);
  }
  return null;
}

/**
 * 解析 ffmpeg.exe。命中/失败都缓存，避免每次请求都扫一遍候选。
 * @returns {Promise<string>} ffmpeg 可执行文件路径
 */
async function resolve({ force = false } = {}) {
  if (cache && !force) {
    if (cache.ok) return cache.exe;
    throw missingError(cache.tried);
  }
  const tried = [];
  const direct = [
    [config.runtime?.ffmpegPath, "config.runtime.ffmpegPath"],
    [config.mux?.ffmpegPath, "config.mux.ffmpegPath"],
    [process.env.AVS_FFMPEG, "AVS_FFMPEG"],
    ["ffmpeg", "PATH"],
  ];
  for (const [exe, source] of direct) {
    const hit = await probe(exe, source, tried);
    if (hit) {
      cache = { ok: true, ...hit };
      log.info(`本机 ffmpeg 就绪：${hit.exe}（来源：${hit.source}）`);
      return hit.exe;
    }
  }

  // 兜底：Python 的 imageio-ffmpeg 包自带一个完整版 ffmpeg.exe
  const r = await python.find({ marker: PY_MARKER, script: PY_SCRIPT, timeoutMs: 30000 });
  if (r.exe) {
    const exe = r.stdout.slice(r.stdout.indexOf(PY_MARKER) + PY_MARKER.length).trim();
    const hit = await probe(exe, "imageio-ffmpeg（Python 包自带）", tried);
    if (hit) {
      cache = { ok: true, ...hit };
      log.info(`本机 ffmpeg 就绪：${hit.exe}（来源：${hit.source}）`);
      return hit.exe;
    }
  } else {
    tried.push(...r.tried);
  }

  cache = { ok: false, tried };
  log.warn(`没有找到可用的 ffmpeg：${tried.join("；")}`);
  throw missingError(tried);
}

/**
 * 跑一次 ffmpeg（参数里记得带 -nostdin，否则管道里它会等键盘输入）。
 * binary: true 时 stdout 是 Buffer（解码 PCM 做能量包络要用，字符串拼接会把字节毁掉）。
 */
async function run(args, { timeoutMs = 900000, cwd = null, binary = false } = {}) {
  const exe = await resolve();
  return proc.run(exe, args, {
    timeoutMs, cwd, binary,
    timeoutMessage: `ffmpeg 处理超时（>${Math.round(timeoutMs / 1000)}s），已终止`,
  });
}


/** 给能力自检 / 诊断接口用：不抛错，只报告现状 */
async function status() {
  try {
    const exe = await resolve();
    const r = await proc.run(exe, ["-hide_banner", "-version"], { timeoutMs: 20000 });
    return { available: true, exe, source: cache?.source || null, version: String(r.stdout).split("\n")[0].trim() };
  } catch (e) {
    return { available: false, exe: null, error: e.message, tried: cache?.tried || [] };
  }
}

module.exports = { resolve, run, status, PY_MARKER };