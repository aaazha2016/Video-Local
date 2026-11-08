"use strict";
/**
 * 剪映生态打通（需求报告 §12.3 方案 A 草稿工程 + 方案 B 标准素材包）。
 * 两种方案都实现；UI 默认走方案 B（兼容性最好）。
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const config = require("./config");
const { createZip } = require("./zip");

const us = (ms) => Math.round(ms * 1000);       // 秒 → 微秒（剪映时间单位）
const fmt = (s) => {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const milli = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${sec},${milli}`;
};

/** 生成 SRT 字幕（报告 §12.4：无 ASR 时用分镜台词或用户文案） */
function buildSrt(lines) {
  return lines.map((l, i) => `${i + 1}\n${fmt(l.start)} --> ${fmt(l.end)}\n${l.text}\n`).join("\n");
}

/**
 * @param {object} o
 *   project   项目行
 *   clips     [{ asset, start_s, duration_s, name }]  视频轨
 *   audios    [{ asset, start_s, duration_s, name }]  音频轨（BGM/配音）
 *   subtitles [{ start, end, text }]
 *   kind      "draft" | "bundle" | "both"
 */
async function buildPackage(o) {
  const projectId = o.project?.id || "noproj";
  const outDir = path.join(config.paths.drafts, "capcut", projectId);
  await fsp.mkdir(path.join(outDir, "materials"), { recursive: true });

  const canvas = o.canvas || { width: 1080, height: 1920 };
  const fps = o.fps || 30;
  const clips = o.clips || [];
  const audios = o.audios || [];
  const totalSec = Math.max(
    clips.reduce((a, c) => a + (c.duration_s || 0), 0),
    audios.reduce((a, c) => a + (c.duration_s || 0), 0),
  );

  const entries = [];
  const materials = { videos: [], audios: [], images: [] };
  const videoSegments = [];
  const audioSegments = [];

  let cursor = 0;
  for (const [i, c] of clips.entries()) {
    const a = c.asset;
    if (!a) continue;
    const ext = path.extname(a.path) || ".mp4";
    const name = c.name || `shot_${i + 1}${ext}`;
    const rel = `materials/${name}`;
    entries.push({ name: `${projectId}/${rel}`, data: await fsp.readFile(a.path) });
    const dur = c.duration_s || 5;
    materials.videos.push({
      id: `m_v${i + 1}`, type: "video", path: rel, duration: us(dur),
      width: canvas.width, height: canvas.height, material_name: name,
    });
    videoSegments.push({
      material_id: `m_v${i + 1}`,
      target_timerange: { start: us(cursor), duration: us(dur) },
      source_timerange: { start: 0, duration: us(dur) },
      speed: 1.0, volume: 1.0,
    });
    cursor += dur;
  }

  let acursor = 0;
  for (const [i, c] of audios.entries()) {
    const a = c.asset;
    if (!a) continue;
    const ext = path.extname(a.path) || ".mp3";
    const name = c.name || `audio_${i + 1}${ext}`;
    const rel = `materials/${name}`;
    entries.push({ name: `${projectId}/${rel}`, data: await fsp.readFile(a.path) });
    const dur = c.duration_s || totalSec || 5;
    materials.audios.push({
      id: `m_a${i + 1}`, type: "audio", path: rel, duration: us(dur), material_name: name,
    });
    audioSegments.push({
      material_id: `m_a${i + 1}`,
      target_timerange: { start: us(c.start_s ?? acursor), duration: us(dur) },
      source_timerange: { start: 0, duration: us(dur) },
      volume: c.volume ?? 1.0,
    });
    acursor += dur;
  }

  const draftContent = {
    canvas_config: { width: canvas.width, height: canvas.height, ratio: "original" },
    fps,
    duration: us(totalSec),
    tracks: [
      { type: "video", segments: videoSegments },
      { type: "audio", segments: audioSegments },
    ],
    materials,
  };
  const draftMeta = {
    draft_name: o.project?.title || "AI 短视频项目",
    canvas_config: draftContent.canvas_config,
    fps,
    duration: draftContent.duration,
    create_time: Math.floor(Date.now() / 1000),
    extra_info: "由 AI 短视频创作平台自动生成（本地 ComfyUI 版）",
  };

  const readme = [
    "剪映草稿包使用说明",
    "====================",
    "",
    "【方案 A：草稿工程（体验最好）】",
    `1. 把 ${projectId}/ 整个目录复制到剪映草稿目录：`,
    "   Windows: %LOCALAPPDATA%\\JianyingPro\\User Data\\Projects\\com.lveditor.draft\\",
    "   macOS:   ~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/",
    "2. 重启剪映，在草稿列表里即可看到本工程。",
    "   注意：剪映草稿格式随版本变化，若无法识别请改用方案 B。",
    "",
    "【方案 B：标准素材包（最稳）】",
    "   materials/ 目录内为全部成片与分轨素材，直接拖入剪映时间线即可使用。",
    "   已按顺序命名：shot_1/shot_2/... 为分镜，bgm/voice 为音频轨。",
    "",
    "【导出规格】",
    "   1080P 竖版 / H.264 / yuv420p / 无水印 / AAC 音轨。",
  ].join("\n");

  entries.push({ name: `${projectId}/draft_content.json`, data: JSON.stringify(draftContent, null, 1) });
  entries.push({ name: `${projectId}/draft_meta_info.json`, data: JSON.stringify(draftMeta, null, 1) });
  entries.push({ name: `${projectId}/README.txt`, data: readme });
  if (o.subtitles?.length) {
    entries.push({ name: `${projectId}/materials/subtitle.srt`, data: buildSrt(o.subtitles) });
  }

  const zipName = `capcut_${projectId}_${Date.now()}.zip`;
  const zipPath = path.join(outDir, zipName);
  await fsp.writeFile(zipPath, createZip(entries));
  return { zipPath, zipName, outDir, entryCount: entries.length, totalSec, draftContent };
}

/** 从项目素材自动组装 clips/audios（供 API-17 直接调用） */
function assembleFromAssets(assets) {
  const videos = assets.filter((a) => a.kind === "video");
  const audios = assets.filter((a) => a.kind === "audio");
  return {
    clips: videos.map((a, i) => ({
      asset: a, name: `shot_${i + 1}${path.extname(a.path) || ".mp4"}`,
      duration_s: (a.duration_ms || 5000) / 1000, start_s: 0,
    })),
    audios: audios.map((a, i) => ({
      asset: a, name: i === 0 ? `bgm${path.extname(a.path) || ".mp3"}` : `voice_${i}${path.extname(a.path) || ".mp3"}`,
      duration_s: (a.duration_ms || 0) / 1000,
    })),
  };
}

module.exports = { buildPackage, assembleFromAssets, buildSrt };
