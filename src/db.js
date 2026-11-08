"use strict";
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const config = require("./config");
const log = require("./logger").scope("db");

const db = new DatabaseSync(config.paths.dbFile);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'creator',
  quota_minutes REAL NOT NULL DEFAULT 999999,
  quota_images INTEGER NOT NULL DEFAULT 999999,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  aspect TEXT NOT NULL DEFAULT '9:16',
  engine_pref TEXT,
  style_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  meta TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS character (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  name TEXT NOT NULL,
  ref_image TEXT,
  ref_images TEXT,
  face_embed BLOB,
  voice_ref TEXT,
  prompt_lock TEXT,
  negative TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS script (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  logline TEXT,
  full_text TEXT,
  shots_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shot (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  duration_s REAL NOT NULL DEFAULT 5,
  shot_type TEXT,
  camera_move TEXT,
  prompt TEXT,
  negative TEXT,
  dialogue TEXT,
  audio_hint TEXT,
  first_frame TEXT,
  last_frame TEXT,
  ref_images TEXT,
  engine TEXT,
  seed INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  meta TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job (
  id TEXT PRIMARY KEY,
  prompt_id TEXT,
  user_id TEXT,
  project_id TEXT,
  shot_id TEXT,
  workflow_id TEXT NOT NULL,
  engine TEXT,
  instance TEXT,
  cuda_index INTEGER,
  vram_class TEXT NOT NULL DEFAULT 'medium',
  params TEXT NOT NULL,
  workflow_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_status ON job(status, created_at);
CREATE INDEX IF NOT EXISTS idx_job_project ON job(project_id, created_at);
CREATE TABLE IF NOT EXISTS asset (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  project_id TEXT,
  shot_id TEXT,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  url TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  fps REAL,
  has_audio INTEGER DEFAULT 0,
  watermark INTEGER DEFAULT 0,
  size_bytes INTEGER,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_project ON asset(project_id, kind);
CREATE TABLE IF NOT EXISTS style_template (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  thumb TEXT,
  prompt_prefix TEXT NOT NULL DEFAULT '',
  prompt_suffix TEXT NOT NULL DEFAULT '',
  negative TEXT NOT NULL DEFAULT '',
  engine_hint TEXT,
  lora_json TEXT,
  camera_json TEXT,
  params_json TEXT,
  source TEXT DEFAULT 'builtin',
  sort_order INTEGER DEFAULT 100
);
CREATE TABLE IF NOT EXISTS capcut_draft (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'building',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);
`;

db.exec(SCHEMA);

const nowIso = () => new Date().toISOString();
const newId = (prefix = "id") => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const j = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const pj = (v, fallback = null) => {
  if (v === undefined || v === null || v === "") return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};

function run(sql, params = []) { return db.prepare(sql).run(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }

function seedAdmin() {
  const u = get("SELECT id FROM user LIMIT 1");
  if (!u) {
    run("INSERT INTO user (id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)", [
      newId("user"), config.auth.username, hashPassword(config.auth.password), "admin", nowIso(),
    ]);
    log.info(`已创建默认账号 ${config.auth.username}`);
  }
}
function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  const h = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return `${salt}:${h}`;
}
function verifyPassword(pw, stored) {
  const [salt, h] = String(stored || "").split(":");
  if (!salt || !h) return false;
  const calc = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(calc, "hex"), Buffer.from(h, "hex"));
}

function logEvent(jobId, message, data, level = "info") {
  run("INSERT INTO app_event (job_id, level, message, data, created_at) VALUES (?,?,?,?,?)", [
    jobId || null, level, message, j(data), nowIso(),
  ]);
}

seedAdmin();

module.exports = { db, run, all, get, nowIso, newId, j, pj, hashPassword, verifyPassword, logEvent };
