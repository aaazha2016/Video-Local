"use strict";
/**
 * 产物命名：<项目名称>_<图片|音频|视频|文本>_<流水号>.<ext>
 *
 * 为什么单独抽一层：
 *   · 素材库里堆上千个文件之后，`job_9f3c_00001_.mp4` 这种名字根本认不出属于哪个项目、是什么东西；
 *     用户要求「生成的文件名 = 项目名称 + 类型 + 流水号」，图片 / 音频 / 视频一眼可辨。
 *   · 「项目重名要先查出来」和「文件名带项目名」是同一件事的两面：两个同名项目产出的文件
 *     在素材库里长得一模一样，事后没法分辨。所以命名和重名校验放在同一个模块里。
 *
 * 所有「生成物落盘」的地方都走这里：ComfyUI 产物下载（jobs.persistFile）、配音 / 音轨合成（mux）、
 * 拼接成片（concat）、字幕烧录（subtitle）、音乐后期（audio-tools）、语音合成（tts）、
 * 视频抽音轨（vocal）。**用户上传的文件不改名** —— 那是他自己的文件，保持原样更好认。
 *
 * 流水号按「目录里已有的同名文件」往后排（每个项目一个目录），所以重新生成不会覆盖上一版，
 * 编号一直递增；项目改名后从 0001 重新排，末尾还有一次存在的兜底检查，不会撞车。
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const store = require("./store");

const KIND_LABEL = { image: "图片", video: "视频", audio: "音频", text: "文本", file: "文件", subtitle: "字幕" };

const NO_PROJECT_NAME = "未归属项目";
const DEFAULT_KIND = "file";
const MAX_STEM = 40;

/** 清理成能当文件名用的字符串：保留中英文数字，其余换下划线 */
function safeName(str, fallback = NO_PROJECT_NAME) {
  const s = String(str == null ? "" : str).trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^\w.\u4e00-\u9fa5-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, MAX_STEM);
  return s || fallback;
}

const kindLabel = (kind) => KIND_LABEL[kind] || KIND_LABEL[DEFAULT_KIND];

/** 项目标题；查不到（或本来就没选项目）就用「未归属项目」兜底 */
function projectTitle(projectId) {
  if (!projectId) return NO_PROJECT_NAME;
  try { return store.project.titleOf(projectId) || NO_PROJECT_NAME; } catch { return NO_PROJECT_NAME; }
}

/** 产物前缀：<项目名称>_<类型> */
function assetStem({ projectId = null, projectTitle: title = null, kind = DEFAULT_KIND } = {}) {
  return `${safeName(title || projectTitle(projectId))}_${kindLabel(kind)}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 目录里这个名字已经排到第几号 */
async function maxSerial(dir, stem) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return 0; }
  const re = new RegExp(`^${escapeRe(stem)}_(\\d+)\\.[^.]+$`);
  let max = 0;
  for (const n of names) {
    const m = re.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * 取下一个产物路径。
 * @param {string} dir  产物目录（通常是 data/exports/<project_id>）
 * @param {{projectId?:string, projectTitle?:string, kind?:string, ext?:string}} o
 * @returns {Promise<string>} 绝对路径，形如 <dir>/<项目名称>_<类型>_0001.mp4
 */
async function nextAssetPath(dir, { projectId = null, projectTitle: title = null, kind = DEFAULT_KIND, ext = ".bin" } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const stem = assetStem({ projectId, projectTitle: title, kind });
  let suffix = String(ext || "").toLowerCase();
  if (!suffix.startsWith(".")) suffix = `.${suffix || "bin"}`;
  const start = (await maxSerial(dir, stem)) + 1;
  for (let i = start; i < start + 500; i += 1) {
    const full = path.join(dir, `${stem}_${String(i).padStart(4, "0")}${suffix}`);
    try { await fsp.access(full); } catch { return full; }
  }
  return path.join(dir, `${stem}_${Date.now()}${suffix}`);
}

/**
 * 项目重名校验。查两处：
 *   ① 同一用户下已经有同名项目；
 *   ② 素材库里已经有以这个项目名开头的产物文件（说明这个名字被别的项目用过了）。
 * 命中任意一条就算重名；前端据此提示，后端在 create / rename 时也会拦一道（除非显式 force）。
 */
function checkProjectName({ userId = "user_local", title, excludeId = null } = {}) {
  const raw = String(title == null ? "" : title).trim();
  const safe = safeName(raw, "");
  const lower = raw.toLowerCase();
  const projects = store.project.list(userId)
    .filter((p) => p.id !== excludeId && String(p.title || "").trim().toLowerCase() === lower);
  const assets = safe ? store.asset.searchBasenamePrefix(`${safe}_`, 50) : [];
  return {
    title: raw,
    safe_name: safe,
    duplicate: projects.length > 0 || assets.length > 0,
    project_duplicate: projects.length > 0,
    asset_duplicate: assets.length > 0,
    projects: projects.map((p) => ({ id: p.id, title: p.title, created_at: p.created_at })),
    assets: assets.map((a) => ({ id: a.id, kind: a.kind, name: path.basename(a.path), project_id: a.project_id })),
  };
}

module.exports = {
  KIND_LABEL, NO_PROJECT_NAME, safeName, kindLabel, projectTitle, assetStem, nextAssetPath, checkProjectName,
};