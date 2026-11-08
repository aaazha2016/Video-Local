"use strict";
/**
 * 字幕：把分镜台词烧进成片（硬字幕），同时把 .srt 留在产物旁边方便导入剪映。
 *
 * 为什么也放本机（同 src/mux.js 的理由）：
 *   - 这是纯像素操作，ffmpeg 一条命令搞定，不需要 GPU，也不该去挤 222 的队列；
 *   - 视频要重编码（字幕是画进画面的），音频直接复制，几分钟的片子几十秒就跑完。
 *
 * 本机 ffmpeg 的构建选项里带 --enable-libass / --enable-fontconfig / --enable-libfreetype，
 * 所以直接走 subtitles 滤镜（比 drawtext 少一层转义地狱）。
 *
 * 两个踩过的坑，都写在下面的 buildAss / wrapText 里：
 *   ① 不能把 SRT 直接丢给 libass —— 它读 SRT 时脚本分辨率写死 384x288，字号会被按
 *      「288 → 视频高度」再放大一遍（1280 高的视频放大 4.4 倍），字会大到糊满屏；
 *   ② libass 对纯中文长句不会自动换行，会把整句拉成一长条冲出画面两侧，所以要自己折行。
 *
 * Windows 路径坑：subtitles 滤镜参数里的盘符冒号必须转义（`D\:/x.ass`）。这里改用
 * 「把工作目录切到字幕所在目录、只传文件名」的办法彻底绕开转义（见 src/proc.js 的 cwd）。
 */

const fsp = require("node:fs/promises");
const path = require("node:path");

const config = require("./config");
const log = require("./logger").scope("subtitle");
const ffmpeg = require("./ffmpeg");
const store = require("./store");
const mux = require("./mux");
const naming = require("./naming");
const { readVideoMeta } = require("./mp4");

const bad = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const pad = (n, w = 2) => String(n).padStart(w, "0");

/** 一个「字」大概占几个字号宽：中文 / 全角算 1，西文和数字算 0.55 */
const CJK = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const CLOSER = /[，。！？、；：）】」』…—,.;:!?)]/;
const charWidth = (ch) => (CJK.test(ch) ? 1 : 0.55);

/** 毫秒 → SRT 时间戳 00:00:01,234 */
function srtTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(t % 1000, 3)}`;
}

/** ASS 时间戳：H:MM:SS.cc */
function assTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${h}:${pad(m)}:${pad(s)}.${pad(Math.floor((t % 1000) / 10))}`;
}

/** 这个画面尺寸下一行最多放几个字（按字号 = 画面高度 / 22 算） */
function maxCharsFor(width, height) {
  const w = Math.max(64, Math.round(Number(width) || 720));
  const h = Math.max(64, Math.round(Number(height) || 1280));
  const size = Math.max(16, h / 22);
  const usable = Math.max(120, w - 2 * Math.round(w * 0.05));
  return Math.max(6, Math.floor(usable / size));
}

/**
 * 把一句台词折成几行。
 * libass 遇到纯中文长句不会自动换行（实测会把整句拉成一长条冲出画面两侧），
 * 自己折好再用 \N 交给它渲染最稳。
 */
function wrapText(text, maxChars) {
  const max = Math.max(6, Number(maxChars) || 12);
  // 花括号 / 反斜杠在 ASS 里是特效标签，先清掉
  const raw = String(text || "").replace(/[{}]/g, "").replace(/\\/g, "/").trim();
  if (!raw) return [];
  const lines = [];
  for (const para of raw.split(/\r?\n/)) {
    let line = "";
    let used = 0;
    for (const ch of para) {
      const cw = charWidth(ch);
      if (line && used + cw > max) {
        if (CLOSER.test(ch)) { lines.push(line + ch); line = ""; used = 0; continue; }   // 标点不顶到下一行行首
        const sp = line.lastIndexOf(" ");
        if (sp > 0 && line.length - sp <= 10) {                                          // 西文别把单词劈开
          lines.push(line.slice(0, sp));
          line = line.slice(sp + 1) + ch;
          used = [...line].reduce((s, x) => s + charWidth(x), 0);
          continue;
        }
        lines.push(line); line = ""; used = 0;
      }
      if (!line && ch === " ") continue;
      line += ch; used += cw;
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

/**
 * 一句太长的台词拆成若干个时间片：每个时间片最多 maxLines 行，时间按字数比例分配。
 * 这样长句子不会一次糊满屏幕（抖音字幕的节奏感也是这么来的）。
 */
function expandEntries(entries, maxChars, maxLines = 2) {
  const out = [];
  for (const e of entries || []) {
    if (!e || !String(e.text || "").trim()) continue;
    const start = Number(e.startMs) || 0;
    const dur = Math.max(300, Number(e.durationMs) || 0);
    const lines = wrapText(e.text, maxChars);
    if (!lines.length) continue;
    const groups = [];
    for (let i = 0; i < lines.length; i += maxLines) groups.push(lines.slice(i, i + maxLines));
    if (groups.length === 1) { out.push({ text: lines.join("\n"), startMs: start, durationMs: dur }); continue; }
    const weights = groups.map((g) => g.reduce((s, l) => s + l.length, 0));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let cursor = start;
    groups.forEach((g, i) => {
      const d = i === groups.length - 1
        ? Math.max(300, start + dur - cursor)
        : Math.max(400, Math.round((dur * weights[i]) / total));
      out.push({ text: g.join("\n"), startMs: cursor, durationMs: d });
      cursor += d;
    });
  }
  return out;
}

/**
 * 折行但**不按时间切片**：一句 = 一条字幕。
 *
 * 为什么需要：expandEntries 会把折成 3 行以上的长句拆成多条字幕、按字数分摊时间，
 * 这在故事模式下是好事（一句话跟着镜头节奏走）；但对**歌词**就是灾难 ——
 * 实测 12 个字的歌词被拆出一条只有「口」、一条只有「亮了」的独立字幕，看着像乱码。
 * 歌词字幕要的就是「一句一条、跟到底」，所以歌词链路走这里。
 */
function keepEntries(entries, maxChars) {
  const out = [];
  for (const e of entries || []) {
    if (!e || !String(e.text || "").trim()) continue;
    const lines = wrapText(e.text, maxChars);
    if (!lines.length) continue;
    out.push({
      text: lines.join("\n"),
      startMs: Number(e.startMs) || 0,
      durationMs: Math.max(300, Number(e.durationMs) || 0),
    });
  }
  return out;
}

/**
 * entries: [{ text, startMs, durationMs }] → SRT 文本
 * 空条目会被跳过并重新编号，避免出现"空字幕"导致 libass 报错。
 * 传了 maxChars 就顺带按画面宽度折行（与硬字幕保持一致）；
 * keepLine = true 时只折行、不再按时间切片（歌词字幕用，见 keepEntries）。
 */
function buildSrt(entries, { maxChars = 0, maxLines = 2, keepLine = false } = {}) {
  const list = keepLine
    ? keepEntries(entries, maxChars || 12)
    : maxChars
      ? expandEntries(entries, maxChars, maxLines)
      : (entries || []).filter((e) => String(e?.text || "").trim() && Number(e.durationMs) > 0);
  if (!list.length) return "";
  return list.map((e, i) => {
    const start = Number(e.startMs) || 0;
    const end = start + Math.max(300, Number(e.durationMs) || 0);
    return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${String(e.text).trim()}\n`;
  }).join("\n");
}

/** 折好的多行文本 → ASS 的换行标记 \N */
function assText(t) {
  return String(t || "").split(/\n/).map((x) => x.trim()).filter(Boolean).join("\\N");
}

/**
 * 生成真正的 ASS 字幕，而不是把 SRT 直接丢给 libass。
 *
 * 自己写 ASS 能把 PlayResX/Y 对齐到视频真实像素，字号 / 边距才是「屏幕上多少像素」，
 * 竖屏横屏都不会一会巨大一会看不清；换行也由 wrapText 算好，不受 libass 的性子影响。
 */
function buildAss(entries, { width = 720, height = 1280, style = null, maxChars = 0, keepLine = false } = {}) {
  const w = Math.max(64, Math.round(Number(width) || 720));
  const h = Math.max(64, Math.round(Number(height) || 1280));
  const chars = maxChars || maxCharsFor(w, h);
  const list = keepLine ? keepEntries(entries, chars) : expandEntries(entries, chars, 2);
  if (!list.length) return "";
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: ${style || assStyle(w, h)}`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    "",
  ].join("\n");
  const body = list.map((e) => {
    const start = Number(e.startMs) || 0;
    const end = start + Math.max(300, Number(e.durationMs) || 0);
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${assText(e.text)}`;
  }).join("\n");
  return `${head}${body}\n`;
}

/**
 * V4+ 样式的 Style: 行。
 * PlayRes 是视频真实像素，所以字号就是「屏幕上多少像素」：字高取画面高度的 1/22，
 * 底边距取 5%，描边按高度微调——竖屏横屏都不会一会巨大一会看不清。
 */
function assStyle(width, height) {
  const w = Math.max(64, Math.round(Number(width) || 720));
  const h = Math.max(64, Math.round(Number(height) || 1280));
  const size = Math.max(16, Math.round(h / 22));
  const outline = Math.max(1, Math.round(h / 380));
  const marginLR = Math.round(w * 0.05);
  const marginV = Math.max(20, Math.round(h * 0.05));
  return [
    "Default", "Microsoft YaHei", size,
    "&H00FFFFFF", "&H00FFFFFF", "&H00000000", "&H80000000",   // 白字 / 黑描边 / 半透明底
    "0", "0", "0", "0", "100", "100", "0", "0",
    "1", outline, "0", "2",                                    // BorderStyle=1 描边、Alignment=2 底部居中
    marginLR, marginLR, marginV, "134",
  ].join(",");
}

/**
 * 按「拼接顺序」整理字幕条目：时间轴直接累加每段素材的真实时长，
 * 所以用户怎么排序、字幕就怎么跟；台词从这段素材所属的分镜（asset.shot_id）里取。
 *
 * @param {object} [o]
 * @param {boolean} [o.skipBurned=true] 跳过「已经自带硬字幕」的片段（默认开）
 * @returns {Promise<{entries:Array, totalMs:number, silent:string[], burned:string[]}>}
 *          silent = 没台词的片段 id；burned = 已经烧过字幕、本次跳过的片段 id
 */
async function entriesFromAssets(assets, { skipBurned = true } = {}) {
  const entries = [];
  const silent = [];
  const burned = [];
  let cursorMs = 0;
  for (const a of assets || []) {
    const sec = await mux.videoSeconds(a).catch(() => 0);
    const durMs = Math.round(sec * 1000);
    const shot = a.shot_id ? store.shot.get(a.shot_id) : null;
    const text = String(shot?.dialogue || "").trim();
    // 片段自己已经烧过字幕（「一键生成全部镜头」的产物）：时间轴照样往前走，
    // 但不能再给它排一条 —— 否则成片上会出现两层叠在一起的字。
    const already = skipBurned && !!a.meta?.subtitle?.burned;
    if (durMs > 0) {
      if (already) burned.push(a.id);
      else if (text) {
        // 前后各留一点余量：字幕不要贴着脸出场，也别卡在下一句的头上
        entries.push({ text, startMs: cursorMs + 120, durationMs: Math.max(700, durMs - 260) });
      } else {
        silent.push(a.id);
      }
      cursorMs += durMs;
    }
  }
  return { entries, totalMs: cursorMs, silent, burned };
}


/**
 * 真的去烧字幕。
 *
 * @param {object} o
 * @param {object} o.video    源视频 asset（path 必填）
 * @param {Array}  o.entries  字幕条目 [{ text, startMs, durationMs }]（顺序即时间轴）
 * @param {string} [o.srt]    另存一份的 SRT 文本（不传就按 entries 现算）
 * @param {string} [o.projectId]
 * @param {string} [o.jobId]
 * @param {string} [o.style]  自定义 V4+ Style 行（可选）
 * @returns {Promise<object>} 新建的 video asset（meta.subtitle 里带 srt/ass 的相对路径）
 */
async function burn(o) {
  if (!o.video?.path) throw bad("PARAM_INVALID", "缺少要烧字幕的视频");
  const entries = (o.entries || []).filter((e) => String(e?.text || "").trim() && Number(e.durationMs) > 0);
  if (!entries.length) throw bad("NO_SUBTITLE", "这条时间线上没有可用的台词，没东西可烧");

  const outDir = path.join(config.paths.exports, o.projectId || "noproj");
  await fsp.mkdir(outDir, { recursive: true });
  const outPath = await naming.nextAssetPath(outDir, { projectId: o.projectId, kind: "video", ext: ".mp4" });

  const meta = await readVideoMeta(o.video.path).catch(() => null);
  const width = meta?.width || o.video.width || 720;
  const height = meta?.height || o.video.height || 1280;
  const maxChars = maxCharsFor(width, height);
  const expanded = o.keepLine ? keepEntries(entries, maxChars) : expandEntries(entries, maxChars, 2);

  // .ass 才是这次烧录的真正来源；.srt 放成片旁边，方便直接拖进剪映当软字幕
  const assPath = outPath.replace(/\.mp4$/i, ".ass");
  const srtPath = outPath.replace(/\.mp4$/i, ".srt");
  await fsp.writeFile(assPath, buildAss(expanded, { width, height, style: o.style, maxChars, keepLine: o.keepLine }), "utf8");
  await fsp.writeFile(srtPath, o.srt || buildSrt(expanded), "utf8");

  const seconds = (meta?.durationMs || o.video.duration_ms || 0) / 1000;
  const timeoutMs = Math.max(300000, Math.round(seconds * 4000) + 300000);
  const assName = path.basename(assPath);
  const outName = path.basename(outPath);

  const base = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", o.video.path];
  const tail = [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(config.mux.fallbackCrf),
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", outName,
  ];
  try {
    // 首选：音频原样复制（不重编码，零损失）
    await ffmpeg.run([...base, "-vf", `subtitles=${assName}`, "-c:a", "copy", ...tail],
      { timeoutMs, cwd: outDir });
  } catch (e) {
    log.warn(`烧字幕时音频直拷失败，改用 AAC 重编码：${String(e.message).split("\n")[0].slice(0, 200)}`);
    await ffmpeg.run([
      ...base, "-vf", `subtitles=${assName}`,
      "-c:a", "aac", "-b:a", config.mux.audioBitrate, "-ar", String(config.mux.sampleRate),
      ...tail,
    ], { timeoutMs, cwd: outDir });
  }

  const st = await fsp.stat(outPath);
  if (!st.size) throw bad("SUBTITLE_EMPTY", "烧字幕没有产出文件，请重试");
  const outMeta = await readVideoMeta(outPath).catch(() => null);

  const rel = path.relative(config.paths.data, outPath).split(path.sep).join("/");
  const srtRel = path.relative(config.paths.data, srtPath).split(path.sep).join("/");
  const assRel = path.relative(config.paths.data, assPath).split(path.sep).join("/");
  const asset = store.asset.create({
    job_id: o.jobId || null, project_id: o.projectId || null, shot_id: o.shotId || null,
    kind: "video", path: outPath, url: `/files/${rel}`, mime: "video/mp4",
    width: outMeta?.width || width, height: outMeta?.height || height,
    duration_ms: outMeta?.durationMs || o.video.duration_ms || null,
    fps: outMeta?.fps || o.video.fps || null,
    has_audio: outMeta ? !!outMeta.hasAudio : !!o.video.has_audio, watermark: false, size_bytes: st.size,
    meta: {
      engine: "local",
      workflow_id: "WF-27",
      source: { video: o.video.id, video_filename: path.basename(o.video.path || "") },
      subtitle: { ass: assRel, srt: srtRel, url: `/files/${srtRel}`, lines: expanded.length, burned: true },
      note: "本机烧录硬字幕（视频重编码为 H.264，音频直拷），旁边另存了一份 .srt 可导入剪映",
    },
  });
  log.info(`烧字幕完成：${outName} ${asset.width}x${asset.height} ${((outMeta?.durationMs || 0) / 1000).toFixed(2)}s ` +
    `${(st.size / 1048576).toFixed(1)}MB（${expanded.length} 条字幕）`);
  return asset;
}

module.exports = { buildSrt, buildAss, wrapText, expandEntries, keepEntries, entriesFromAssets, burn, assStyle, srtTime, maxCharsFor };
