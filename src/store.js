"use strict";
/** 数据访问层：把 SQL 收敛在这里，路由与任务编排只调用语义化方法。 */

const crypto = require("node:crypto");
const path = require("node:path");
const db = require("./db");
const config = require("./config");

const nowIso = () => new Date().toISOString();
const newId = (p) => `${p}_${crypto.randomBytes(6).toString("hex")}`;
const J = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const P = (v, d = null) => { if (!v) return d; try { return JSON.parse(v); } catch { return d; } };

// ---------------------------------------------------------------- 用户
const user = {
  find(username) { return db.get("SELECT * FROM user WHERE username=?", [username]); },
  get(id) { return db.get("SELECT * FROM user WHERE id=?", [id]); },
  verify(password, hash) { return require("./db").verifyPassword(password, hash); },
  hash(password) { return require("./db").hashPassword(password); },
};

// ---------------------------------------------------------------- 项目
const project = {
  create({ userId, title, aspect = "9:16", enginePref = null, styleId = null, meta = null }) {
    const id = newId("p");
    db.run(`INSERT INTO project (id,user_id,title,aspect,engine_pref,style_id,status,meta,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, userId, title || "未命名项目", aspect, enginePref, styleId, "draft", J(meta), nowIso(), nowIso()]);
    return this.get(id);
  },
  get(id) {
    const r = db.get("SELECT * FROM project WHERE id=?", [id]);
    return r ? { ...r, meta: P(r.meta) } : null;
  },
  list(userId) {
    return db.all("SELECT * FROM project WHERE user_id=? ORDER BY updated_at DESC", [userId])
      .map((r) => ({ ...r, meta: P(r.meta) }));
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const f = { title: cur.title, aspect: cur.aspect, engine_pref: cur.engine_pref, style_id: cur.style_id, status: cur.status, ...patch };
    db.run(`UPDATE project SET title=?,aspect=?,engine_pref=?,style_id=?,status=?,meta=?,updated_at=? WHERE id=?`,
      [f.title, f.aspect, f.engine_pref, f.style_id, f.status, J(patch.meta !== undefined ? patch.meta : cur.meta), nowIso(), id]);
    return this.get(id);
  },
  /** 只要标题（产物命名用，避免为了一个名字把整个项目对象拉出来） */
  titleOf(id) {
    if (!id) return null;
    const r = db.get("SELECT title FROM project WHERE id=?", [id]);
    return r ? r.title : null;
  },
  /** 同一用户下标题完全一样的项目（重名校验用） */
  findByTitle(userId, title) {
    const t = String(title == null ? "" : title).trim().toLowerCase();
    if (!t) return [];
    return db.all("SELECT * FROM project WHERE user_id=?", [userId])
      .filter((r) => String(r.title || "").trim().toLowerCase() === t)
      .map((r) => ({ ...r, meta: P(r.meta) }));
  },
  touch(id) { db.run("UPDATE project SET updated_at=? WHERE id=?", [nowIso(), id]); },
  remove(id) { db.run("DELETE FROM project WHERE id=?", [id]); },
};

// ---------------------------------------------------------------- 角色卡
const character = {
  create(d) {
    const id = newId("char");
    db.run(`INSERT INTO character (id,project_id,name,ref_image,ref_images,voice_ref,prompt_lock,negative,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, d.project_id || null, d.name || "角色", d.ref_image || null, J(d.ref_images || []),
        d.voice_ref || null, d.prompt_lock || "", d.negative || "", nowIso(), nowIso()]);
    return this.get(id);
  },
  get(id) { const r = db.get("SELECT * FROM character WHERE id=?", [id]); return r ? { ...r, ref_images: P(r.ref_images, []) } : null; },
  list(projectId) {
    const rows = projectId
      ? db.all("SELECT * FROM character WHERE project_id=? ORDER BY created_at DESC", [projectId])
      : db.all("SELECT * FROM character ORDER BY created_at DESC", []);
    return rows.map((r) => ({ ...r, ref_images: P(r.ref_images, []) }));
  },
  update(id, patch) {
    const c = this.get(id);
    if (!c) return null;
    const f = { ...c, ...patch };
    db.run(`UPDATE character SET name=?,ref_image=?,ref_images=?,voice_ref=?,prompt_lock=?,negative=?,updated_at=? WHERE id=?`,
      [f.name, f.ref_image, J(patch.ref_images !== undefined ? patch.ref_images : c.ref_images), f.voice_ref, f.prompt_lock, f.negative, nowIso(), id]);
    return this.get(id);
  },
  remove(id) { db.run("DELETE FROM character WHERE id=?", [id]); },
};

// ---------------------------------------------------------------- 剧本 / 分镜
const script = {
  create({ projectId, logline = "", fullText = "", shots = [] }) {
    const id = newId("scr");
    db.run(`INSERT INTO script (id,project_id,logline,full_text,shots_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      [id, projectId, logline, fullText, J(shots), nowIso(), nowIso()]);
    return this.get(id);
  },
  get(id) { const r = db.get("SELECT * FROM script WHERE id=?", [id]); return r ? { ...r, shots_json: P(r.shots_json, []) } : null; },
  list(projectId) { return db.all("SELECT * FROM script WHERE project_id=? ORDER BY created_at DESC", [projectId]).map((r) => ({ ...r, shots_json: P(r.shots_json, []) })); },
  update(id, patch) {
    const s = this.get(id);
    if (!s) return null;
    const f = { ...s, ...patch };
    db.run("UPDATE script SET logline=?,full_text=?,shots_json=?,updated_at=? WHERE id=?",
      [f.logline, f.full_text, J(patch.shots_json !== undefined ? patch.shots_json : s.shots_json), nowIso(), id]);
    return this.get(id);
  },
  remove(id) { db.run("DELETE FROM script WHERE id=?", [id]); },
};

const shot = {
  create(d) {
    const id = newId("s");
    db.run(`INSERT INTO shot (id,script_id,project_id,idx,duration_s,shot_type,camera_move,prompt,negative,dialogue,audio_hint,
             first_frame,last_frame,ref_images,engine,seed,status,meta,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, d.script_id, d.project_id, d.idx ?? 1, d.duration_s ?? 5, d.shot_type || "中景", d.camera_move || "static",
        d.prompt || "", d.negative || "", d.dialogue || "", d.audio_hint || "", d.first_frame || null, d.last_frame || null,
        J(d.ref_images || []), d.engine || null, d.seed ?? null, d.status || "pending", J(d.meta), nowIso(), nowIso()]);
    return this.get(id);
  },
  get(id) { const r = db.get("SELECT * FROM shot WHERE id=?", [id]); return r ? { ...r, ref_images: P(r.ref_images, []), meta: P(r.meta) } : null; },
  list(scriptId) { return db.all("SELECT * FROM shot WHERE script_id=? ORDER BY idx ASC", [scriptId]).map((r) => ({ ...r, ref_images: P(r.ref_images, []), meta: P(r.meta) })); },
  listByProject(projectId) { return db.all("SELECT * FROM shot WHERE project_id=? ORDER BY idx ASC", [projectId]).map((r) => ({ ...r, ref_images: P(r.ref_images, []), meta: P(r.meta) })); },
  update(id, patch) {
    const s = this.get(id);
    if (!s) return null;
    // undefined 代表"本次不改这个字段"，必须剔除：否则展开后会覆盖已有值，
    // 并把 undefined 绑给 SQLite 导致 "cannot be bound to SQLite parameter"。
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([, v]) => v !== undefined));
    const f = { ...s, ...clean };
    db.run(`UPDATE shot SET idx=?,duration_s=?,shot_type=?,camera_move=?,prompt=?,negative=?,dialogue=?,audio_hint=?,
             first_frame=?,last_frame=?,ref_images=?,engine=?,seed=?,status=?,meta=?,updated_at=? WHERE id=?`,
      [f.idx, f.duration_s, f.shot_type, f.camera_move, f.prompt, f.negative, f.dialogue, f.audio_hint,
        f.first_frame, f.last_frame, J(clean.ref_images !== undefined ? clean.ref_images : s.ref_images),
        f.engine, f.seed, f.status, J(clean.meta !== undefined ? clean.meta : s.meta), nowIso(), id]);
    return this.get(id);
  },
  remove(id) { db.run("DELETE FROM shot WHERE id=?", [id]); },
};

// ---------------------------------------------------------------- 任务
const job = {
  create(d) {
    const id = newId("job");
    db.run(`INSERT INTO job (id,prompt_id,user_id,project_id,shot_id,workflow_id,engine,instance,cuda_index,vram_class,
             params,workflow_json,status,progress,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, d.prompt_id || null, d.user_id || null, d.project_id || null, d.shot_id || null,
        d.workflow_id, d.engine || null, d.instance || null, d.cuda_index ?? null, d.vram_class || "medium",
        J(d.params || {}), d.workflow_json ? J(d.workflow_json) : null, d.status || "queued", 0, nowIso()]);
    return this.get(id);
  },
  get(id) { const r = db.get("SELECT * FROM job WHERE id=?", [id]); return r ? { ...r, params: P(r.params, {}), workflow_json: P(r.workflow_json) } : null; },
  list({ projectId, status, limit = 100 } = {}) {
    const where = []; const args = [];
    if (projectId) { where.push("project_id=?"); args.push(projectId); }
    if (status) { where.push("status=?"); args.push(status); }
    args.push(limit);
    return db.all(`SELECT * FROM job ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`, args)
      .map((r) => ({ ...r, params: P(r.params, {}) }));
  },
  byPromptId(pid) { const r = db.get("SELECT * FROM job WHERE prompt_id=?", [pid]); return r ? { ...r, params: P(r.params, {}) } : null; },
  update(id, patch) {
    const sets = []; const args = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k}=?`);
      args.push(k === "params" || k === "workflow_json" ? J(v) : v);
    }
    if (!sets.length) return this.get(id);
    args.push(id);
    db.run(`UPDATE job SET ${sets.join(",")} WHERE id=?`, args);
    return this.get(id);
  },
  pending() { return db.all("SELECT * FROM job WHERE status IN ('queued','dispatching') ORDER BY created_at ASC").map((r) => ({ ...r, params: P(r.params, {}) })); },
  running() { return db.all("SELECT * FROM job WHERE status='running'").map((r) => ({ ...r, params: P(r.params, {}) })); },
  stats() {
    return db.all("SELECT status, COUNT(*) AS n FROM job GROUP BY status").reduce((a, r) => (a[r.status] = r.n, a), {});
  },
};

// ---------------------------------------------------------------- 素材
const asset = {
  create(d) {
    const id = newId("a");
    db.run(`INSERT INTO asset (id,job_id,project_id,shot_id,kind,path,url,mime,width,height,duration_ms,fps,has_audio,watermark,size_bytes,meta,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, d.job_id || null, d.project_id || null, d.shot_id || null, d.kind, d.path, d.url, d.mime,
        d.width ?? null, d.height ?? null, d.duration_ms ?? null, d.fps ?? null, d.has_audio ? 1 : 0,
        d.watermark ? 1 : 0, d.size_bytes ?? null, J(d.meta), nowIso()]);
    return this.get(id);
  },
  get(id) { const r = db.get("SELECT * FROM asset WHERE id=?", [id]); return r ? { ...r, meta: P(r.meta), has_audio: !!r.has_audio } : null; },
  list({ projectId, kind, limit = 200 } = {}) {
    const where = []; const args = [];
    if (projectId) { where.push("project_id=?"); args.push(projectId); }
    if (kind) { where.push("kind=?"); args.push(kind); }
    args.push(limit);
    return db.all(`SELECT * FROM asset ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`, args)
      .map((r) => ({ ...r, meta: P(r.meta), has_audio: !!r.has_audio }));
  },
  byJob(jobId) { return db.all("SELECT * FROM asset WHERE job_id=? ORDER BY created_at ASC", [jobId]).map((r) => ({ ...r, meta: P(r.meta) })); },
  byHash(hash) { return db.get("SELECT * FROM asset WHERE json_extract(meta,'$.sha256')=? LIMIT 1", [hash]); },
  /**
   * 「素材库里有没有以这个前缀开头的文件」——项目重名校验用。
   * 先让 SQLite 粗筛（LIKE 走不到索引，但素材表体量有限），再用 basename 精确比对，
   * 避免路径里的目录名把结果带偏（data/exports/p_xxx/项目名_图片_0001.png）。
   */
  searchBasenamePrefix(prefix, limit = 50) {
    const p = String(prefix || "");
    if (!p) return [];
    return db.all("SELECT id, project_id, kind, path, created_at FROM asset WHERE path LIKE ? ORDER BY created_at DESC LIMIT ?",
      [`%${p}%`, limit])
      .filter((r) => path.basename(String(r.path || "")).startsWith(p));
  },
  /** 这条视频有没有已经抽过音轨（vocal.ensureSongAsset 的缓存判断，避免重复登记同一个产物） */
  findExtractedFrom(videoAssetId) {
    if (!videoAssetId) return null;
    const rows = db.all("SELECT * FROM asset WHERE kind='audio' AND meta LIKE ? ORDER BY created_at DESC LIMIT 20",
      [`%${videoAssetId}%`]);
    for (const r of rows) {
      const meta = P(r.meta);
      if (meta && meta.source && meta.source.extracted_from === videoAssetId) return { ...r, meta, has_audio: !!r.has_audio };
    }
    return null;
  },
  remove(id) { db.run("DELETE FROM asset WHERE id=?", [id]); },
  /** 同一个文件还被几条素材记录引用（上传按「哈希_原名」落盘，可能多条记录共用一个文件） */
  pathUse(p) { const r = db.get("SELECT COUNT(*) AS n FROM asset WHERE path=?", [p]); return r ? r.n : 0; },
  /** 回填历史素材缺失的技术参数（只补空值，不覆盖已有数据） */
  setTech(id, info) {
    if (!id || !info) return;
    db.run("UPDATE asset SET width=COALESCE(width,?), height=COALESCE(height,?), fps=COALESCE(fps,?), duration_ms=COALESCE(duration_ms,?) WHERE id=?",
      [info.width || null, info.height || null, info.fps || null, info.durationMs || null, id]);
  },
  /**
   * 只更新 meta（浅合并，不覆盖已有键）。
   * 目前用在「出歌之后顺手写同步歌词」：把 .lrc / .srt / .ass 的地址挂到音频素材上，
   * 前端直接读 meta.subtitle 给下载入口，不用再单独建表。
   */
  updateMeta(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const meta = { ...(cur.meta || {}), ...(patch || {}) };
    db.run("UPDATE asset SET meta=? WHERE id=?", [J(meta), id]);
    return this.get(id);
  },
};


// ---------------------------------------------------------------- 风格模板
const style = {
  upsert(s) {
    db.run(`INSERT INTO style_template (id,name,category,thumb,prompt_prefix,prompt_suffix,negative,engine_hint,lora_json,camera_json,params_json,source,sort_order)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,prompt_prefix=excluded.prompt_prefix,
              prompt_suffix=excluded.prompt_suffix,negative=excluded.negative,engine_hint=excluded.engine_hint,params_json=excluded.params_json`,
      [s.id, s.name, s.category, s.thumb || null, s.prompt_prefix || "", s.prompt_suffix || "", s.negative || "",
        s.engine_hint || null, J(s.lora_json), J(s.camera_json), J(s.params_json), s.source || "builtin", s.sort_order ?? 100]);
  },
  get(id) { const r = db.get("SELECT * FROM style_template WHERE id=?", [id]); return r ? { ...r, params_json: P(r.params_json) } : null; },
  list(category) {
    const rows = category
      ? db.all("SELECT * FROM style_template WHERE category=? ORDER BY sort_order,name", [category])
      : db.all("SELECT * FROM style_template ORDER BY sort_order,name");
    return rows.map((r) => ({ ...r, params_json: P(r.params_json) }));
  },
};

// ---------------------------------------------------------------- 剪映草稿
const draft = {
  create({ projectId, path }) {
    const id = newId("draft");
    db.run("INSERT INTO capcut_draft (id,project_id,path,status,created_at) VALUES (?,?,?,?,?)",
      [id, projectId, path, "building", nowIso()]);
    return db.get("SELECT * FROM capcut_draft WHERE id=?", [id]);
  },
  update(id, patch) {
    const sets = []; const args = [];
    for (const [k, v] of Object.entries(patch)) { sets.push(`${k}=?`); args.push(v); }
    args.push(id);
    db.run(`UPDATE capcut_draft SET ${sets.join(",")} WHERE id=?`, args);
    return db.get("SELECT * FROM capcut_draft WHERE id=?", [id]);
  },
  list(projectId) { return db.all("SELECT * FROM capcut_draft WHERE project_id=? ORDER BY created_at DESC", [projectId]); },
  get(id) { return db.get("SELECT * FROM capcut_draft WHERE id=?", [id]); },
};

// ---------------------------------------------------------------- 事件日志
const event = {
  log({ jobId = null, level = "info", message, data = null }) {
    db.run("INSERT INTO app_event (job_id,level,message,data,created_at) VALUES (?,?,?,?,?)",
      [jobId, level, message, J(data), nowIso()]);
  },
  list(jobId, limit = 200) {
    return db.all("SELECT * FROM app_event WHERE job_id=? ORDER BY id DESC LIMIT ?", [jobId, limit])
      .map((r) => ({ ...r, data: P(r.data) })).reverse();
  },
};

module.exports = {
  user, project, character, script, shot, job, asset, style, draft, event,
  seedStyles(styles) { for (const s of styles) style.upsert(s); },
  config,
};
