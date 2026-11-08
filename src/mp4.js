"use strict";
/**
 * MP4 / MOV 容器解析（原先长在 jobs.js 里，现在独立出来给成片合成复用）。
 *
 * 只读文件头/尾两段就能拿到像素尺寸、帧数、时长、帧率、有没有音轨：
 * 判断「异形片段」、换算重采样帧数、给本机合成的产物回填元数据都要用它。
 * 刻意不用 ffprobe —— 这里不该为了元数据去起外部进程，更不该把整段视频读进内存。
 */

const fsp = require("node:fs/promises");
/** 在 [start,end) 区间里按顺序走一遍 box，命中指定类型即返回 */
function findBox(buf, start, end, type) {
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const t = buf.toString("ascii", i + 4, i + 8);
    let header = 8;
    if (size === 1) { if (i + 16 > end) return null; size = Number(buf.readBigUInt64BE(i + 8)); header = 16; }
    else if (size === 0) size = end - i;
    if (size < header || i + size > end) return null;
    if (t === type) return { start: i, end: i + size, header: header };
    i += size;
  }
  return null;
}

/** 同上，但返回所有同名 box（一个 moov 下会有多个 trak） */
function findBoxes(buf, start, end, type, limit = 16) {
  const out = [];
  let i = start;
  while (i + 8 <= end && out.length < limit) {
    let size = buf.readUInt32BE(i);
    const t = buf.toString("ascii", i + 4, i + 8);
    let header = 8;
    if (size === 1) { if (i + 16 > end) break; size = Number(buf.readBigUInt64BE(i + 8)); header = 16; }
    else if (size === 0) size = end - i;
    if (size < header || i + size > end) break;
    if (t === type) out.push({ start: i, end: i + size, header: header });
    i += size;
  }
  return out;
}

/** mvhd / mdhd 的时间字段布局一致：v1 用 64 位时长 */
function readTimeBox(buf, box) {
  const p = box.start + box.header;
  if (buf[p] === 1) return { timescale: buf.readUInt32BE(p + 20), duration: Number(buf.readBigUInt64BE(p + 24)) };
  return { timescale: buf.readUInt32BE(p + 12), duration: buf.readUInt32BE(p + 16) };
}

/**
 * 探测 MP4/MOV 的真实参数：像素尺寸、帧数、时长、帧率、是否含音轨。
 * 拼接时靠这些值判断某一段是不是「异形」（尺寸或帧率与主流不一致），
 * 以及换算重采样后的目标帧数（帧率不同只改 fps 会让画面变慢动作）。
 * 允许传入「文件片段」：先按顶层 box 走，不成立再按 moov 字符串定位（非 faststart 的 mp4 把 moov 放在尾部）。
 */
function probeVideoMeta(buf) {
  try {
    if (!buf || buf.length < 64) return null;
    let moov = findBox(buf, 0, buf.length, "moov");
    if (!moov) {
      let from = 0;
      for (;;) {
        const idx = buf.indexOf(Buffer.from("moov", "ascii"), from);
        if (idx < 4) return null;
        from = idx + 4;
        const start = idx - 4;
        const size = start + 4 <= buf.length ? buf.readUInt32BE(start) : 0;
        if (size >= 8 && start + size <= buf.length) { moov = { start: start, end: start + size, header: 8 }; break; }
      }
    }
    const out = { width: null, height: null, frames: null, durationMs: null, fps: null, hasAudio: false };
    const mvhd = findBox(buf, moov.start + moov.header, moov.end, "mvhd");
    if (mvhd) {
      const m = readTimeBox(buf, mvhd);
      if (m.timescale > 0 && m.duration > 0) out.durationMs = Math.round((m.duration / m.timescale) * 1000);
    }
    for (const trak of findBoxes(buf, moov.start + moov.header, moov.end, "trak")) {
      const mdia = findBox(buf, trak.start + trak.header, trak.end, "mdia");
      if (!mdia) continue;
      const hdlr = findBox(buf, mdia.start + mdia.header, mdia.end, "hdlr");
      const handler = hdlr ? buf.toString("ascii", hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12) : "";
      if (handler === "soun") { out.hasAudio = true; continue; }
      if (handler !== "vide") continue;
      // 尺寸/帧率只认第一条视频轨，但**不能 break**：
      // mp4 里常见的顺序是 trak[vide] 在前、trak[soun] 在后，
      // 一 break 就再也看不到音轨了（本机合成的成品正是这个顺序）。
      if (out.width) continue;
      const tkhd = findBox(buf, trak.start + trak.header, trak.end, "tkhd");
      if (tkhd) {
        out.width = Math.round(buf.readUInt32BE(tkhd.end - 8) / 65536);
        out.height = Math.round(buf.readUInt32BE(tkhd.end - 4) / 65536);
      }
      const mdhd = findBox(buf, mdia.start + mdia.header, mdia.end, "mdhd");
      const minf = findBox(buf, mdia.start + mdia.header, mdia.end, "minf");
      const stbl = minf ? findBox(buf, minf.start + minf.header, minf.end, "stbl") : null;
      const stsz = stbl ? findBox(buf, stbl.start + stbl.header, stbl.end, "stsz") : null;
      if (stsz) {
        const count = buf.readUInt32BE(stsz.start + stsz.header + 8);
        if (count > 0) out.frames = count;   // 视频轨一个 sample 就是一帧
      }
      if (mdhd) {
        const mm = readTimeBox(buf, mdhd);
        if (mm.timescale > 0 && mm.duration > 0 && out.frames) {
          out.fps = Math.round((out.frames / (mm.duration / mm.timescale)) * 1000) / 1000;
        }
      }
    }
    if (!out.width || !out.height) return null;
    return out;
  } catch (e) { return null; }
}

/** 只读文件头/尾两段来解析视频参数，避免为了元数据把整段视频读进内存 */
async function readVideoMeta(file) {
  let st = null;
  try { st = await fsp.stat(file); } catch { return null; }
  if (!st.isFile() || !st.size) return null;
  const fh = await fsp.open(file, "r");
  try {
    const headLen = Number(Math.min(st.size, 512 * 1024));
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    const hit = probeVideoMeta(head);
    if (hit) return hit;
    if (st.size > headLen) {
      const tailLen = Number(Math.min(st.size - headLen, 4 * 1024 * 1024));
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, Number(st.size - tailLen));
      return probeVideoMeta(tail);
    }
    return null;
  } catch (e) { return null; } finally { await fh.close(); }
}

module.exports = { findBox, findBoxes, readTimeBox, probeVideoMeta, readVideoMeta };