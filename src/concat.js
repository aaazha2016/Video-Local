"use strict";
/**
 * 本机拼接成片（ffmpeg concat）：把用户挑好、排好序的片段首尾相接成一条成片。
 *
 * 为什么不再走 222 的 ConcatenateVideo（WF-16）：
 *   1. 那条路要先把每一段「上传」回 222，片段一大就直接撞上 ComfyUI 的
 *      单请求 100MB 上限（HTTP 413 Maximum request body size exceeded），
 *      十几段一起拼更是必然失败；就算不撞上限，几百兆来回传一遍也是白等。
 *   2. 拼接是纯 I/O 活儿：不碰模型、不吃显存，放本机 ffmpeg 秒级完成，
 *      还把 222 的显卡完整留给真正需要它的生成任务。
 *   3. 顺序完全由调用方给的 asset 数组决定 —— 用户在前端怎么排、成片就怎么接。
 *
 * 规格对齐（WF-16 那三条硬约束这里一样存在，只是换本机处理）：
 *   - 分辨率必须一致：以「多数派」为目标，异形片段 scale + pad 到目标尺寸；
 *   - 帧率必须一致：异形片段按时间轴等比抽帧（只改 -r 会变成慢动作）；
 *   - 音轨必须「全有」或「全无」：只要有一段带声音，就给没声音的段落补一条等长静音轨。
 * 规格本来就一致的片段直接流拷贝拼接（不重编码、几秒钟完事），不一致时才重新编码，
 * 流拷贝万一失败还有一次整段重编码兜底。
 */

const fsp = require("node:fs/promises");
const path = require("node:path");

const config = require("./config");
const log = require("./logger").scope("concat");
const ffmpeg = require("./ffmpeg");
const store = require("./store");
const mux = require("./mux");
const naming = require("./naming");
const { readVideoMeta } = require("./mp4");

const bad = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const even = (n) => { const v = Math.max(2, Math.round(n)); return v % 2 ? v + 1 : v; };
const BASE = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(config.mux.fallbackCrf), "-pix_fmt", "yuv420p"];
const AAC = ["-c:a", "aac", "-b:a", config.mux.audioBitrate, "-ar", String(config.mux.sampleRate), "-ac", "2"];
/**
 * 拼接前「原声对齐」的目标档位：与 mux.dub 的 original_volume_db 默认值一致。
 * 配音过的镜头是「原声 -14dB + 人声 0dB」；没台词的镜头也压到 -14dB，整条片子才是同一条混音。
 */
const LEVEL_DB = -14;

/** 出现次数最多的「宽 x 高 @帧率」组合 —— 它最可能是这批片段的「主规格」 */
function pickTarget(infos) {
  const known = (infos || []).filter((s) => s && s.width && s.height);
  if (!known.length) return { width: 720, height: 1280, fps: 24 };
  const tally = new Map();
  for (const s of known) {
    const key = `${s.width}x${s.height}@${s.fps || 0}`;
    const t = tally.get(key) || { width: s.width, height: s.height, fps: s.fps || 0, n: 0 };
    t.n += 1;
    tally.set(key, t);
  }
  let best = null;
  for (const t of tally.values()) {
    if (!best || t.n > best.n || (t.n === best.n && t.fps > (best.fps || 0))) best = t;
  }
  return { width: even(best.width), height: even(best.height), fps: best.fps || 24 };
}

/**
 * 1080P：把短边放大到 1080 以上（720x1280 → 1080x1920，736x1280 → 1080x1878），长宽都取偶数。
 * 注意：源片段本来就够大时**绝不能缩**——那不是"高清导出"而是降画质，所以短边已经 ≥1080 就原样返回。
 */
function upscale(target) {
  const short = Math.min(target.width, target.height);
  if (short >= 1080) return { ...target };
  const k = 1080 / short;
  return { width: even(target.width * k), height: even(target.height * k), fps: target.fps };
}

/**
 * 读出一段素材的真实参数（尺寸 / 帧率 / 有没有声音 / 时长），
 * 顺带读出「这一镜实际生效的模型原声档」和「有没有合成过人声」—— 拼接前统一音量要用。
 *   配音产物（mux.dub）   ：meta.voice_volume_db 有值，meta.original_volume_db 是被压过的档
 *   原声对齐产物（regain） ：只有 meta.original_volume_db，没有人声
 *   模型直出 / 上传素材    ：两个都没有，原声就是满档 0dB
 */
async function probe(asset) {
  const meta = await readVideoMeta(asset.path).catch(() => null);
  const sec = meta?.durationMs ? meta.durationMs / 1000 : await mux.videoSeconds(asset).catch(() => 0);
  const am = asset.meta || {};
  const rawDb = Number(am.original_volume_db);
  const hasLevel = am.original_volume_db !== undefined && am.original_volume_db !== null && Number.isFinite(rawDb);
  return {
    asset,
    width: meta?.width || asset.width || null,
    height: meta?.height || asset.height || null,
    fps: meta?.fps || asset.fps || null,
    hasAudio: meta ? !!meta.hasAudio : !!asset.has_audio,
    ms: Math.round(sec * 1000) || asset.duration_ms || 0,
    gainDb: hasLevel ? rawDb : 0,
    dubbed: am.voice_volume_db !== undefined && am.voice_volume_db !== null,
  };
}

/** 单个片段对齐到目标规格（尺寸 / 帧率 / 音轨有无） */
async function normalize(s, out, target, withAudio, timeoutMs) {
  const vf = `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,`
    + `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,`
    + `fps=${target.fps},format=yuv420p`;
  const args = [...BASE, "-i", s.asset.path];
  if (!withAudio) {
    args.push("-vf", vf, "-an", ...X264, "-movflags", "+faststart", out);
  } else if (s.hasAudio) {
    args.push("-vf", vf, ...X264, ...AAC, "-movflags", "+faststart", out);
  } else {
    // 这段本身没声音：补一条等长的静音轨，"全有或全无" 的约束才不会翻车
    args.push("-f", "lavfi", "-t", Math.max(0.2, (s.ms || 1000) / 1000).toFixed(3),
      "-i", `anullsrc=channel_layout=stereo:sample_rate=${config.mux.sampleRate}`,
      "-vf", vf, "-map", "0:v:0", "-map", "1:a:0",
      ...X264, ...AAC, "-shortest", "-movflags", "+faststart", out);
  }
  await ffmpeg.run(args, { timeoutMs });
}

/** 兜底：把所有片段丢进 concat 滤镜一次性重编码（流拷贝失败时才走这里） */
async function reencodeConcat(segs, out, withAudio, timeoutMs) {
  const args = [...BASE];
  for (const p of segs) args.push("-i", p);
  const parts = [];
  for (let i = 0; i < segs.length; i += 1) {
    parts.push(`[${i}:v:0]`);
    if (withAudio) parts.push(`[${i}:a:0]`);
  }
  const filter = `${parts.join("")}concat=n=${segs.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? "[a]" : ""}`;
  args.push("-filter_complex", filter, "-map", "[v]");
  if (withAudio) args.push("-map", "[a]", ...AAC);
  args.push(...X264, "-movflags", "+faststart", out);
  await ffmpeg.run(args, { timeoutMs });
}

/** 把 BGM 盖到整条成片上（循环到片子结束，音量压低，不压过人声） */
async function mixBgm(src, bgmPath, out, withAudio, timeoutMs, bgmVolume = 0.3) {
  const vol = String(Math.max(0.05, Math.min(1, Number(bgmVolume) || 0.3)));
  const args = [...BASE, "-i", src, "-stream_loop", "-1", "-i", bgmPath];
  if (withAudio) {
    args.push("-filter_complex", `[1:a]volume=${vol}[b];[0:a][b]amix=inputs=2:duration=first:normalize=0[a]`,
      "-map", "0:v:0", "-map", "[a]");
  } else {
    args.push("-map", "0:v:0", "-map", "1:a:0");
  }
  args.push("-c:v", "copy", ...AAC, "-shortest", "-movflags", "+faststart", out);
  await ffmpeg.run(args, { timeoutMs });
}

/**
 * 拼接成片。
 *
 * @param {object} o
 * @param {Array}  o.assets      按「用户排好的顺序」给出的 video asset
 * @param {string} [o.projectId]
 * @param {string} [o.jobId]
 * @param {object} [o.bgm]       可选 BGM asset（循环铺满整片）
 * @param {number} [o.bgmVolume]  BGM 音量 0~1（默认 0.3，不压过人声）
 * @param {boolean} [o.hd]       输出 1080P（放大到短边 ≥1080）
 * @param {boolean} [o.levelAudio=true] 拼接前把「没台词的片段」原声压到与配音镜头同一档（修「一条片子里几种混音」）
 * @param {number}  [o.levelDb]  统一到的原声档（dB，默认 -14，与 mux 的 original_volume_db 默认值一致）
 * @returns {Promise<object>} 新建的 video asset
 */
async function concatVideos(o) {
  const assets = (o.assets || []).filter((a) => a && a.kind === "video" && a.path);
  if (!assets.length) throw bad("NO_ASSET", "没有可用于合成的视频素材");

  const infos = [];
  for (const a of assets) infos.push(await probe(a));
  const totalMs = infos.reduce((s, x) => s + (x.ms || 0), 0);
  if (!totalMs) throw bad("NO_ASSET", "这些片段都读不出时长，没法拼接");

  // ⓪ 原声对齐（关键一步）：一条片子里既有「配过音的镜头」（原声已压到 -14dB + 人声 0dB），
  // 又有「没台词的镜头」（原声还是满档、也没有人声）时，直接拼起来就是「几种混音混着放、音量忽大忽小」。
  // 所以在对规格动手之前，先把所有「没人声的片段」的原声压到与配音镜头同一档，成片才是一条干净的混音。
  let leveled = 0;
  let levelDb = null;
  if (o.levelAudio !== false) {
    const dubbed = infos.filter((s) => s.dubbed && s.hasAudio);
    if (dubbed.length) {
      // 目标档位取「配音镜头里最常见的那个档」（通常就是 -14dB），保证与已经配好音的片段完全一致
      const tally = new Map();
      for (const s of dubbed) tally.set(s.gainDb, (tally.get(s.gainDb) || 0) + 1);
      let best = -1;
      for (const [db, n] of tally) if (n > best) { best = n; levelDb = db; }
      for (const s of infos) {
        // 有台词的片段原声已经定档，不能重压（重压会把合成好的人声丢掉）
        if (!s.hasAudio || s.dubbed || s.gainDb === levelDb) continue;
        const fixed = await mux.regain({
          video: s.asset, projectId: o.projectId, jobId: o.jobId, originalDb: levelDb,
        });
        if (!fixed) continue;   // 源本身没音轨：没有原声可压（probe 已按文件判定，这里只是兜底）
        s.asset = fixed;
        s.gainDb = levelDb;
        leveled += 1;
      }
      if (leveled) log.info(`拼接前原声对齐：${leveled} 段没有台词的片段，原声统一压到 ${levelDb}dB`);
      else levelDb = null;
    }
  }

  const withAudio = infos.some((x) => x.hasAudio) || !!o.bgm;
  let target = pickTarget(infos);
  if (o.hd) target = upscale(target);
  target.fps = Math.min(60, Math.max(12, Math.round(target.fps || 24)));

  const outDir = path.join(config.paths.exports, o.projectId || "noproj");
  await fsp.mkdir(outDir, { recursive: true });
  const outPath = await naming.nextAssetPath(outDir, { projectId: o.projectId, kind: "video", ext: ".mp4" });

  const workDir = path.join(config.paths.renders, `concat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  await fsp.mkdir(workDir, { recursive: true });
  const timeoutMs = Math.max(600000, Math.round((totalMs / 1000) * 4000) + 600000);

  const segs = [];
  let fixed = 0;
  try {
    // ① 逐段对齐到同一规格；本来就合规的直接引用原文件，省一次重编码
    for (let i = 0; i < infos.length; i += 1) {
      const s = infos[i];
      const ok = s.width === target.width && s.height === target.height
        && s.fps && Math.abs(s.fps - target.fps) < 0.05
        && (withAudio ? s.hasAudio : !s.hasAudio);
      if (ok) { segs.push(s.asset.path); continue; }
      const out = path.join(workDir, `seg_${String(i).padStart(3, "0")}.mp4`);
      await normalize(s, out, target, withAudio, timeoutMs);
      segs.push(out);
      fixed += 1;
    }

    // ② 拼接：先试流拷贝（不重编码，快），失败再整段重编码兜底
    const raw = path.join(workDir, "concat_raw.mp4");
    const listFile = path.join(workDir, "list.txt");
    await fsp.writeFile(listFile, segs.map((p) =>
      `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n", "utf8");
    const copyOut = o.bgm ? raw : outPath;
    try {
      await ffmpeg.run([...BASE, "-f", "concat", "-safe", "0", "-i", listFile,
        "-c", "copy", "-movflags", "+faststart", copyOut], { timeoutMs });
    } catch (e) {
      log.warn(`流拷贝拼接失败，改用重编码兜底：${String(e.message).split("\n")[0].slice(0, 200)}`);
      await reencodeConcat(segs, copyOut, withAudio, timeoutMs);
    }

    // ③ BGM（可选）：循环铺满整条片子
    if (o.bgm?.path) await mixBgm(copyOut, o.bgm.path, outPath, withAudio, timeoutMs, o.bgmVolume);
  } finally {
    // 只清理我们自己在 renders 下建的这一次临时目录
    const dir = path.resolve(workDir);
    if (dir.startsWith(path.resolve(config.paths.renders))) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const st = await fsp.stat(outPath);
  if (!st.size) throw bad("CONCAT_EMPTY", "拼接没有产出文件，请重试");
  const outMeta = await readVideoMeta(outPath).catch(() => null);
  const rel = path.relative(config.paths.data, outPath).split(path.sep).join("/");
  const asset = store.asset.create({
    job_id: o.jobId || null, project_id: o.projectId || null, kind: "video",
    path: outPath, url: `/files/${rel}`, mime: "video/mp4",
    width: outMeta?.width || target.width, height: outMeta?.height || target.height,
    duration_ms: outMeta?.durationMs || totalMs,
    fps: outMeta?.fps || target.fps,
    has_audio: outMeta ? !!outMeta.hasAudio : withAudio,
    watermark: false, size_bytes: st.size,
    meta: {
      engine: "local",
      workflow_id: "WF-16L",
      source: { videos: infos.map((s) => s.asset.id), order: infos.map((s) => s.asset.id) },
      concat: { segments: infos.length, conformed: fixed, leveled, level_db: levelDb,
        width: target.width, height: target.height,
        fps: target.fps, hd: !!o.hd, bgm: o.bgm?.id || null },
      note: "本机 ffmpeg 拼接（顺序按你排的来，规格不一致的片段自动统一），无水印 1080P 级素材，可直接拖进剪映",
    },
  });
  log.info(`拼接成片完成：${path.basename(outPath)} ${asset.width}x${asset.height}@${asset.fps} `
    + `${((outMeta?.durationMs || totalMs) / 1000).toFixed(2)}s ${(st.size / 1048576).toFixed(1)}MB`
    + `（${infos.length} 段，其中 ${fixed} 段做了规格对齐`
    + `${leveled ? `，${leveled} 段原声统一到 ${levelDb}dB` : ""}${o.bgm ? "，已混 BGM" : ""}）`);
  return asset;
}

module.exports = { concatVideos, pickTarget, upscale, probe, LEVEL_DB };