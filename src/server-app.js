"use strict";
/** Express 应用装配：实现需求报告 §6 的 API-01 ~ API-20。 */

const express = require("express");
const path = require("node:path");
const fsp = require("node:fs/promises");
const fss = require("node:fs");
const crypto = require("node:crypto");

const config = require("./config");
const log = require("./logger").scope("api");
const auth = require("./auth");
const store = require("./store");
const naming = require("./naming");
const templates = require("./templates");
const storyboard = require("./storyboard");
const capcut = require("./capcut");
const { checkCapabilities, getWorkflow } = require("./workflows.registry");
const { BUILTIN_STYLES } = require("./styles");
const { checkLlms, resolveLlmSelection } = require("./llm");
const external = require("./llm-external");
const tts = require("./tts");
const vocal = require("./vocal");
const mux = require("./mux");
const compress = require("./compress");
const music = require("./music");
const audioTools = require("./audio-tools");

const subtitle = require("./subtitle");
const concat = require("./concat");
const lyrics = require("./lyrics");
const { SYSTEM_PROMPTS } = require("./workflows.text");
const { createZip } = require("./zip");

const MIME_BY_EXT = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4",
  ".txt": "text/plain", ".json": "application/json", ".srt": "text/plain",
};
const EXT_BY_MIME = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/flac": ".flac", "audio/mp4": ".m4a",
};
const err = (code, message, status = 400, detail = null) => Object.assign(new Error(message), { code, status, detail });

/**
 * 项目重名校验（新建 / 改名共用）。
 *
 * 为什么连素材库一起查：产物文件名是「项目名称_类型_流水号」（见 src/naming.js），
 * 两个同名项目产出的文件在素材库里长得一模一样，事后分不清是谁的 —— 所以在源头就拦住。
 * 前端会先调 /api/projects/name-check 做实时提示，这里再兜一道底：直接打接口也一样拦得住。
 */
function assertProjectNameFree(userId, title, excludeId = null) {
  const chk = naming.checkProjectName({ userId, title, excludeId });
  if (!chk.duplicate) return chk;
  const why = [
    chk.project_duplicate ? "已经有同名项目" : "",
    chk.asset_duplicate ? `素材库里已经有 ${chk.assets.length} 个以它开头的文件` : "",
  ].filter(Boolean).join("，");
  throw err("NAME_DUPLICATED",
    `「${title}」这个名称已经用过了（${why}）。换一个名字，或勾选「仍然使用这个名称」后重试。`,
    409, chk);
}

/**
 * 删除素材：先删库里的记录，再清理磁盘文件。
 *
 * 以前只删记录，文件会一直堆在 data/exports、data/uploads 里 —— 素材库看着删干净了、磁盘一点没减。
 * 三条硬约束：
 *   ① 只删 data 目录以内的文件；不在 data 下的（比如手工放进去的素材）一律留着；
 *   ② 同一个文件还被别的素材记录引用时留着（上传按「内容哈希_原文件名」落盘，可能多条记录共用一个文件）；
 *   ③ 删文件失败只记日志、不影响接口返回 —— 记录已经删掉了，这时候报错反而让用户以为没删成功。
 */
async function removeAssets(ids) {
  const out = { deleted: 0, files: 0, missing: [], kept: [] };
  const root = path.resolve(config.paths.data) + path.sep;
  for (const id of ids) {
    const a = store.asset.get(id);
    if (!a) { out.missing.push(id); continue; }
    store.asset.remove(id);
    out.deleted += 1;
    const abs = a.path ? path.resolve(a.path) : "";
    if (!abs || !abs.startsWith(root)) { if (a.path) out.kept.push(a.path); continue; }
    if (store.asset.pathUse(a.path) > 0 || (a.path !== abs && store.asset.pathUse(abs) > 0)) { out.kept.push(a.path); continue; }
    try { await fsp.unlink(abs); out.files += 1; } catch (e) { log.warn(`素材文件删除失败 ${abs}: ${e.message}`); }
  }
  if (out.deleted) log.info(`删除素材 ${out.deleted} 个（清掉 ${out.files} 个文件，${out.missing.length} 个已不存在）`);
  return out;
}

/**
 * 拼接完成 → 本机烧字幕（WF-27）。
 *
 * 为什么拆成两步而不是一条工作流：拼接要占 222 的显卡、字幕是纯本机像素活儿，
 * 硬凑在一起就等于让 GPU 空等一次转码。这里等 WF-16 出片后再起一个「本机任务」，
 * 任务中心能看到两条独立记录，产物各自可下载。
 *
 * 失败只写日志 + 事件，不影响已经交出去的拼接任务。
 */
async function burnAfterConcat(jobs, { projectId, assets, concatJobId }) {
  const done = await jobs.waitFor(concatJobId, config.comfy.videoJobTimeoutMs || 3600000);
  if (done?.status !== "succeeded") {
    store.event.log({ jobId: concatJobId, level: "warn", message: `拼接未成功（${done?.status || "未知"}），已跳过烧字幕` });
    return;
  }
  const film = store.asset.byJob(concatJobId).find((a) => a.kind === "video");
  if (!film) {
    store.event.log({ jobId: concatJobId, level: "warn", message: "拼接任务没有产出可用的视频素材，已跳过烧字幕" });
    return;
  }
  const { entries, silent, burned } = await subtitle.entriesFromAssets(assets);
  if (!entries.length) {
    // 两种情况要分开说：① 片段在「一键生成全部镜头」时就烧过字幕了，成片上本来就有字，
    // 这里再烧一层就会叠字；② 分镜表里确实没有台词，真的没东西可烧。
    const msg = burned.length
      ? `选中的 ${burned.length} 段在生成镜头时已经自带字幕，跳过重复烧录`
      : "选中的片段都没有分镜台词，没东西可烧";
    store.event.log({ jobId: concatJobId, level: burned.length ? "info" : "warn", message: msg });
    return;
  }

  await jobs.runLocal({
    workflowId: "WF-27", projectId, title: "拼接成片 · 烧字幕",
    params: { refs: { source_video: film.id }, lines: entries.length, silent_segments: silent.length },
    run: (j) => subtitle.burn({ jobId: j.id, projectId, video: film, entries }),
  });
}

function createApp({ pool, jobs }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));
  app.use(auth.middleware);

  // ------------------------------------------------------------- 统一响应
  const ok = (res, data) => res.json({ ok: true, data, error: null });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------------------------------------------------------------- LLM 调用
  const promptLib = require("./prompt");

  /**
   * 统一的「让 LLM 产出文本」入口，两种后端共用同一套重试 / 解析逻辑：
   *   transport = local    → 提交 ComfyUI 的 WF-24（权重在 192.168.0.222，不出网）
   *   transport = external → 直连第三方 OpenAI 兼容 / Anthropic 接口
   * 返回 { text, jobId }；失败抛出的 message 可直接展示给用户。
   */
  /**
   * 歌词要写多长：跟着成品时长走。
   * 60 秒 ≈ 26 行，2 分钟 ≈ 34 行，3 分钟以上 ≈ 40 行（不含段落标签）。
   */
  function lyricsMinLines(seconds) {
    const s = Number(seconds) || 0;
    return s >= 180 ? 40 : s >= 120 ? 34 : s >= 60 ? 26 : 20;
  }

  /** 歌词生成的采样上限：行数越多给得越宽（本地模型会被 4096 截断） */
  function lyricsMaxLength(seconds) {
    return Math.min(3600, Math.max(1200, lyricsMinLines(seconds) * 60));
  }

  async function generateLlmText(pick, opts) {
    const mode = opts.mode || "image_prompt";
    if (pick.transport === "external") {
      // withMeta：把「正文是否被 token 上限截断」带回去。分镜这类长 JSON 被截断时，
      // 调用方要能看出来并接着补写，而不是把半截结果当成品（附录 AG）。
      const ext = await external.chat(pick.connector, {
        model: pick.model,
        system: opts.systemPrompt || SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.image_prompt,
        user: opts.userInput,
        temperature: opts.temperature,
        maxTokens: opts.maxLength,
        timeoutMs: opts.timeoutMs || 180000,
        withMeta: true,
      });
      return { text: ext.text, jobId: null, truncated: !!ext.truncated, maxTokens: ext.budget || null };
    }
    const job = await jobs.submit({
      workflowId: "WF-24", projectId: opts.projectId || null,
      params: {
        ...pick.params, mode,
        user_input: opts.userInput,
        system_prompt: opts.systemPrompt,
        max_length: opts.maxLength,
        temperature: opts.temperature,
        thinking: opts.thinking === undefined ? pick.params.thinking : !!opts.thinking,
      },
    });
    const done = await jobs.waitFor(job.id, opts.timeoutMs || 300000);
    if (done.status !== "succeeded") throw err("LLM_FAILED", done.error || "本地模型生成失败", 502);
    return { text: (await jobs.readJobText(job.id)) || "", jobId: job.id, truncated: false };
  }

  const llmMeta = (pick) => ({ id: pick.llmId, label: pick.label, source: pick.transport });

  /**
   * 括号不配平 = 这段 JSON 从中间被切断了。
   * 本机模型顶到 max_length 也是同样的表现（保存的文本就是半截），所以两条链路都用它兜底判断。
   */
  const looksTruncated = (t) => {
    let curly = 0, square = 0;
    for (const ch of String(t || "")) {
      if (ch === "{") curly += 1;
      else if (ch === "}") curly -= 1;
      else if (ch === "[") square += 1;
      else if (ch === "]") square -= 1;
    }
    return curly !== 0 || square !== 0;
  };

  // ------------------------------------------------------------- API-01 登录
  app.post("/api/auth/login", wrap(async (req, res) => {
    const { username, password } = req.body || {};
    const user = store.user ? store.user.find(username) : null;
    if (user && store.user.verify(password, user.password_hash)) {
      return ok(res, { token: auth.sign({ sub: user.id, username: user.username, role: user.role }), user: { id: user.id, username: user.username, role: user.role } });
    }
    if (!config.auth.enabled) {
      return ok(res, { token: auth.sign({ sub: "user_local", username: config.auth.username, role: "admin" }), user: { id: "user_local", username: config.auth.username, role: "admin" } });
    }
    throw err("BAD_CREDENTIALS", "用户名或密码错误", 401);
  }));

  // ------------------------------------------------------- API-02 能力发现
  app.get("/api/system/capabilities", wrap(async (_req, res) => {
    const cap = await checkCapabilities(pool);
    ok(res, {
      ...cap,
      limits: config.limits,
      aspects: config.limits.aspects,
      export: config.export,
      auth_enabled: config.auth.enabled,
      styles: store.style.list().map((s) => ({ id: s.id, name: s.name, category: s.category, engine_hint: s.engine_hint })),
      templates: templates.meta(),
    });
  }));

  // ------------------------------------------------------ API-03 实例状态
  app.get("/api/system/instances", wrap(async (_req, res) => ok(res, pool.status())));
  // 多卡并行池总览（槽位 / 每卡负载）
  app.get("/api/system/pool", wrap(async (_req, res) => ok(res, { capacity: pool.capacity(), instances: pool.status() })));
  // 本地 LLM 清单：故事创作 / 文案扩写的模型选择器数据源
  app.get("/api/system/llms", wrap(async (_req, res) => ok(res, await checkLlms(pool))));

  // ------------------------------------------- API-03b 外部商业模型连接器
  // API Key 只进不出：GET 一律返回打码值，前端永远不会拿到完整 Key。
  app.get("/api/llm/providers", wrap(async (_req, res) => ok(res, {
    presets: external.PRESETS,
    connectors: external.listPublic(),
    store_file: path.relative(config.ROOT, external.STORE_FILE),
  })));

  app.post("/api/llm/providers", wrap(async (req, res) => {
    const r = external.createConnector(req.body || {});
    if (r.error) throw err("LLM_CONFIG", r.error, 400);
    ok(res, r.connector);
  }));

  app.patch("/api/llm/providers/:id", wrap(async (req, res) => {
    const r = external.updateConnector(req.params.id, req.body || {});
    if (r.missing) throw err("NOT_FOUND", "连接器不存在", 404);
    if (r.error) throw err("LLM_CONFIG", r.error, 400);
    ok(res, r.connector);
  }));

  app.delete("/api/llm/providers/:id", wrap(async (req, res) => {
    const r = external.removeConnector(req.params.id);
    if (r.missing) throw err("NOT_FOUND", "连接器不存在", 404);
    ok(res, { deleted: true });
  }));

  // 连通性测试：既能测已保存的连接器（传 id），也能测表单里还没保存的配置。
  // 优先 GET /models 把真实模型清单拉回来，前端据此生成下拉框。
  app.post("/api/llm/providers/test", wrap(async (req, res) => {
    const b = req.body || {};
    const saved = b.id ? external.getConnector(b.id) : null;
    const cfg = {
      label: b.label || (saved && saved.label) || "未命名连接器",
      baseUrl: String(b.base_url ?? b.baseUrl ?? (saved && saved.baseUrl) ?? "").trim().replace(/\/+$/, ""),
      kind: ((b.kind ?? (saved && saved.kind)) === "anthropic") ? "anthropic" : "openai",
      apiKey: (b.api_key ?? b.apiKey) || (saved && saved.apiKey) || "",
      model: String(b.model ?? (saved && saved.model) ?? "").trim(),
    };
    const result = await external.probe(cfg, { model: cfg.model, timeoutMs: Number(b.timeout_ms) || 30000 });
    if (saved) external.recordTest(saved.id, result);
    ok(res, result);
  }));
  // ------------------------------------------- API-21 语音合成（配音）服务
  // 与外部模型连接器同一套约定：Key 只进不出，前端只拿到打码值。
  // 默认内置一条 edge 通道（跑在本机 Python 上，免费、不需要 Key、不出网）。
  app.get("/api/tts/providers", wrap(async (_req, res) => {
    const st = await tts.status();
    ok(res, { ...st, store_file: path.relative(config.ROOT, tts.STORE_FILE) });
  }));

  app.post("/api/tts/providers", wrap(async (req, res) => ok(res, tts.createProvider(req.body || {}))));
  app.patch("/api/tts/providers/:id", wrap(async (req, res) => ok(res, tts.updateProvider(req.params.id, req.body || {}))));
  app.delete("/api/tts/providers/:id", wrap(async (req, res) => ok(res, tts.removeProvider(req.params.id))));

  // 连通性测试：edge 通道检查本机 Python + edge-tts；OpenAI 兼容通道真的合成一句短话。
  app.post("/api/tts/providers/test", wrap(async (req, res) => {
    const b = req.body || {};
    const saved = b.id ? tts.getProvider(b.id) : null;
    const cfg = {
      id: saved ? saved.id : "(未保存)",
      label: b.label || (saved && saved.label) || "未命名语音服务",
      kind: b.kind || (saved && saved.kind) || "edge",
      baseUrl: String(b.base_url ?? b.baseUrl ?? (saved && saved.baseUrl) ?? "").trim().replace(/\/+$/, ""),
      apiKey: (b.api_key ?? b.apiKey) || (saved && saved.apiKey) || "",
      model: String(b.model ?? (saved && saved.model) ?? "").trim(),
      voice: String(b.voice ?? (saved && saved.voice) ?? "").trim(),
      enabled: true,
    };
    const result = await tts.probe(cfg);
    if (saved) tts.recordTest(saved.id, result);
    ok(res, result);
  }));

  // 试听：直接回音频字节，不落素材（前端 new Audio(url) 即可播放）
  app.post("/api/tts/preview", wrap(async (req, res) => {
    const b = req.body || {};
    const { buffer, mime } = await tts.synthesize({
      providerId: b.tts_provider || b.provider || null,
      text: b.text, voice: b.voice,
      rate: b.rate, volume: b.volume, pitch: b.pitch, speed: b.speed,
    });
    res.setHeader("Content-Type", mime || "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  }));

  // 合成并落成音色素材（供配音页与故事创作复用；也可单独拿去做素材）
  app.post("/api/tts/synthesize", wrap(async (req, res) => {
    const b = req.body || {};
    const r = await tts.synthesizeToAsset({
      text: b.text, providerId: b.tts_provider || b.provider || null,
      voice: b.voice, rate: b.rate, volume: b.volume, pitch: b.pitch, speed: b.speed,
      projectId: b.project_id || null,
    });
    ok(res, {
      asset_id: r.asset.id, url: r.asset.url, duration_ms: r.asset.duration_ms,
      provider: r.provider, voice: r.voice, chars: r.chars,
      note: "配音已生成并存入素材库，可直接用于「配音合成」或故事创作",
    });
  }));
  app.post("/api/system/instances/refresh", wrap(async (_req, res) => {
    await Promise.all(pool.instances.map((i) => i.refreshStats()));
    ok(res, pool.status());
  }));
  app.post("/api/system/free", wrap(async (_req, res) => {
    const out = [];
    for (const i of pool.instances) { try { out.push({ id: i.id, result: await i.freeMemory() }); } catch (e) { out.push({ id: i.id, error: e.message }); } }
    ok(res, out);
  }));
  app.post("/api/system/capabilities/recheck", wrap(async (_req, res) => ok(res, await checkCapabilities(pool, { force: true }))));
  // 本机合成通道自检：配音 / 换音轨全靠它（不占 222 的 GPU）
  app.get("/api/system/mux", wrap(async (_req, res) => ok(res, await mux.status())));

  // ------------------------------------------------------------ API-04 上传
  app.post("/api/upload", express.raw({ type: () => true, limit: `${config.limits.maxUploadMB}mb` }), wrap(async (req, res) => {
    const raw = req.headers["x-filename"] || "upload.bin";
    const filename = decodeURIComponent(raw).replace(/[^\w.\-]+/g, "_");
    const projectId = req.query.project_id || req.headers["x-project-id"] || "common";
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    if (!buf.length) throw err("EMPTY_BODY", "上传内容为空");
    const ext = path.extname(filename).toLowerCase();
    const mime = req.headers["content-type"] || MIME_BY_EXT[ext] || "application/octet-stream";
    const kind = ["video/mp4", "video/webm", "video/quicktime"].includes(mime) ? "video"
      : mime.startsWith("audio/") ? "audio" : mime.startsWith("image/") ? "image" : "file";
    const dir = path.join(config.paths.uploads, projectId);
    await fsp.mkdir(dir, { recursive: true });
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const dest = path.join(dir, `${sha.slice(0, 12)}_${filename}`);
    await fsp.writeFile(dest, buf);
    const rel = path.relative(config.paths.data, dest).split(path.sep).join("/");
    const asset = store.asset.create({
      project_id: projectId === "common" ? null : projectId, kind, path: dest, url: `/files/${rel}`,
      mime, size_bytes: buf.length, has_audio: kind === "audio", watermark: false,
      meta: { sha256: sha, origin_name: filename, uploaded: true },
    });
    ok(res, { asset_id: asset.id, ...asset });
  }));

  // ------------------------------------------------------------- API-05 项目
  app.get("/api/projects", wrap(async (req, res) => ok(res, store.project.list(req.user?.id || "user_local"))));
  app.post("/api/projects", wrap(async (req, res) => {
    const b = req.body || {};
    const userId = req.user?.id || "user_local";
    const title = String(b.title == null ? "" : b.title).trim();
    if (title && b.force !== true) assertProjectNameFree(userId, title, null);
    ok(res, store.project.create({ userId, title: b.title, aspect: b.aspect, enginePref: b.engine_pref, styleId: b.style_id, meta: b.meta }));
  }));

  /** 项目重名实时校验：只查不写库，供前端边打字边提示（必须排在 /api/projects/:id 前面） */
  app.get("/api/projects/name-check", wrap(async (req, res) => {
    ok(res, naming.checkProjectName({
      userId: req.user?.id || "user_local",
      title: req.query.title,
      excludeId: req.query.exclude_id || null,
    }));
  }));
  app.get("/api/projects/:id", wrap(async (req, res) => {
    const p = store.project.get(req.params.id);
    if (!p) throw err("NOT_FOUND", "项目不存在", 404);
    ok(res, { ...p, characters: store.character.list(p.id), scripts: store.script.list(p.id), assets: store.asset.list({ projectId: p.id }) });
  }));
  app.patch("/api/projects/:id", wrap(async (req, res) => {
    const b = req.body || {};
    const cur = store.project.get(req.params.id);
    if (!cur) throw err("NOT_FOUND", "项目不存在", 404);
    const title = String(b.title == null ? "" : b.title).trim();
    // 只有真的改了名字才校验，免得每次改画幅 / 风格都因为历史同名被拦住
    if (title && title !== String(cur.title || "").trim() && b.force !== true) {
      assertProjectNameFree(cur.user_id, title, req.params.id);
    }
    ok(res, store.project.update(req.params.id, b));
  }));
  app.delete("/api/projects/:id", wrap(async (req, res) => { store.project.remove(req.params.id); ok(res, { deleted: true }); }));

  // ----------------------------------------------------------- API-06 角色卡
  /**
   * 给角色卡补上「参考图还剩几张、失效几张」。
   *
   * 为什么需要：角色卡里的参考图可能已经被从素材库删掉了（用户清过素材库 / 换过形象图），
   * 角色卡里却还留着那些旧 id。把它标出来，前端才能提示「参考图已失效，建议重新生成」，
   * 而不是等出图了才发现人物长得不像。
   */
  const characterWithRefs = (c) => {
    const ids = [...new Set([...(c.ref_images || []), ...(c.ref_image ? [c.ref_image] : [])])];
    const missing = ids.filter((id) => !store.asset.get(id));
    return {
      ...c,
      refs_total: ids.length,
      refs_missing: missing.length,
      refs_live: ids.length - missing.length,
      stale_refs: missing,
    };
  };
  app.get("/api/characters", wrap(async (req, res) =>
    ok(res, store.character.list(req.query.project_id).map(characterWithRefs))));
  app.post("/api/characters", wrap(async (req, res) => {
    const b = { ...(req.body || {}) };
    // 新建时顺手把「已经不在素材库里」的 id 摘掉，别让角色卡一建好就带着读不到文件的死链（同 PATCH）
    if (Array.isArray(b.ref_images)) b.ref_images = b.ref_images.filter((id) => store.asset.get(id));
    if (b.ref_image && !store.asset.get(b.ref_image)) b.ref_image = b.ref_images?.[0] || null;
    ok(res, characterWithRefs(store.character.create(b)));
  }));
  app.patch("/api/characters/:id", wrap(async (req, res) => {
    const b = { ...(req.body || {}) };
    // 指向「已经不在素材库里」的 id 留着没有任何用处（出图时根本读不到文件），更新时顺手摘掉；
    // 用户重新生成 / 上传形象图之后，角色卡就能自然回到干净状态。
    if (Array.isArray(b.ref_images)) b.ref_images = b.ref_images.filter((id) => store.asset.get(id));
    if (b.ref_image !== undefined && (!b.ref_image || !store.asset.get(b.ref_image))) b.ref_image = null;
    const c = store.character.update(req.params.id, b);
    if (!c) throw err("NOT_FOUND", "角色不存在", 404);
    ok(res, characterWithRefs(c));
  }));
  app.delete("/api/characters/:id", wrap(async (req, res) => { store.character.remove(req.params.id); ok(res, { deleted: true }); }));

  // -------------------------------------------------- API-07 提示词智能扩写
  // 本地模型走 WF-24，外部商业模型直连第三方接口；两者共用解析逻辑。
  app.post("/api/prompt/enhance", wrap(async (req, res) => {
    const b = req.body || {};
    const mode = b.mode || "image_prompt";
    // 模型选择：llm / preset / thinking（见 src/llm.js 与 src/llm-external.js）
    const pick = resolveLlmSelection(b);
    if (pick.error) throw err("LLM_UNSUPPORTED", pick.error, 400);

    let text = "", jobId = null;
    try {
      const out = await generateLlmText(pick, {
        mode,
        userInput: b.text || b.prompt || "",
        systemPrompt: b.system_prompt,
        maxLength: pick.params.max_length || 900,
        temperature: pick.params.temperature,
        timeoutMs: b.timeout_ms || (pick.transport === "external" ? 180000 : 240000),
        projectId: b.project_id,
      });
      text = out.text; jobId = out.jobId;
    } catch (e) {
      throw err("LLM_FAILED", e.message || "提示词扩写失败", 502);
    }
    ok(res, {
      job_id: jobId, mode, raw: text,
      result: promptLib.extractJson(text),
      llm: llmMeta(pick),
    });
  }));
  // ---------------------------------------------------- API-08 剧本 / 分镜
  app.post("/api/script/generate", wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.project_id) throw err("PARAM_INVALID", "缺少 project_id");
    const want = Math.max(0, Math.round(Number(b.shot_count || 0)));
    // 风格模板 / 角色卡如果选了，就把名字和提示词锁一起交给大模型，
    // 让它拆分镜时就按这个画风和人物写（出片阶段 jobs 还会再用一次 style_id / character_ids）。
    const styleRow = b.style_id ? store.style.get(b.style_id) : null;
    const charRows = (Array.isArray(b.character_ids) ? b.character_ids : []).map((id) => store.character.get(id)).filter(Boolean);
    const wantDuration = Number(b.duration_s || 0);
    const userInput = [
      b.story || b.prompt || "",
      want > 0 ? `镜头数量：必须正好 ${want} 个镜头（idx 从 1 连续编到 ${want}，不多也不少）。` : "",
      wantDuration > 0 ? `单镜时长：每个镜头的 duration_s 都写成 ${wantDuration}。` : "",
      styleRow ? `统一画风：${styleRow.name}${styleRow.prompt_prefix ? `（${styleRow.prompt_prefix}）` : ""}，每个镜头的提示词都要贴合这个风格。` : "",
      charRows.length ? `固定角色：${charRows.map((c) => `${c.name}${c.prompt_lock ? `（${c.prompt_lock}）` : ""}`).join("；")}，各镜头保持同一人物长相。` : "",
      "再次强调：JSON 的每个键名必须是小写英文且不含空格，例如 shot_type / camera_move / duration_s / audio_hint。",
    ].filter(Boolean).join("\n");
    const pick = resolveLlmSelection(b);
    if (pick.error) throw err("LLM_UNSUPPORTED", pick.error, 400);

    // token 预算按镜头数算：一个镜头含画面描述 + 台词大约 250~300 token。
    // 以前不管拆几个都只给 2600，外部模型还会被 4096 的下限兜住 —— 36 个镜头必然写到一半被截断，
    // 存下来的就是「十来个镜头」的半截结果（附录 AJ）。
    const isExternal = pick.transport === "external";
    const estTokens = want > 0 ? 600 + want * 280 : 0;
    const maxLength = Math.min(
      isExternal ? 32000 : 8192,
      Math.max(pick.params.max_length || 0, b.max_length || (want > 5 ? 2600 : 1600), estTokens),
    );

    // 镜头数量必须写进系统提示：只在用户输入里说一句「请拆成 N 个镜头」，模型会当建议而自由发挥。
    const systemPrompt = want > 0
      ? `${SYSTEM_PROMPTS.storyboard}\n本次硬性要求：shots 数组必须正好 ${want} 个元素，idx 从 1 连续编到 ${want}，`
        + `每个镜头都要把 prompt / duration_s / shot_type / camera_move 写全。镜头数量优先于总时长：`
        + `不要因为「总时长 20 秒以上」而少拆镜头，也不要写一半就收尾。`
      : SYSTEM_PROMPTS.storyboard;

    // 模型偶尔会输出键名带空格 / 缺逗号的 JSON，导致解析不出分镜。
    // 这里做有限重试（最多 2 次）：第二次降低温度，提高结构化输出成功率。
    let jobId = null, text = "", parsed = {}, shots = [], lastError = null, truncated = false;
    for (let attempt = 0; attempt < 2 && !shots.length; attempt++) {
      const temperature = attempt > 0
        ? Math.min(0.5, Number(pick.params.temperature) || 0.7)
        : pick.params.temperature;
      try {
        const out = await generateLlmText(pick, {
          mode: "storyboard", userInput,
          systemPrompt,
          maxLength, temperature,
          timeoutMs: b.timeout_ms || (isExternal ? 180000 : 300000),
          projectId: b.project_id,
          thinking: pick.params.thinking,
        });
        jobId = out.jobId; text = out.text;
        // 外部模型看 finish_reason，本机模型看 JSON 括号是否配平 —— 两种都说明「写到一半被切断了」
        truncated = !!out.truncated || looksTruncated(text);
      } catch (e) {
        lastError = e.message || "剧本生成失败";
        continue;
      }
      parsed = promptLib.extractJson(text) || {};
      shots = promptLib.normalizeShots(parsed, { duration_s: wantDuration });
    }

    // 镜头数不够（模型自己收尾，或输出被长度上限切断）：按缺口继续要，最多补 3 轮。
    // 以前这里直接把半截结果存下来，于是「填 36 个镜头，只得到十来个」。
    for (let round = 0; want > 0 && shots.length && shots.length < want && round < 3; round++) {
      const need = want - shots.length;
      const from = shots.length + 1;
      const lastPrompt = String(shots[shots.length - 1].prompt || "").slice(0, 60);
      const moreInput = [
        b.story || b.prompt || "",
        `这是同一条片子的续写：前 ${shots.length} 个镜头已经写完（第 ${shots.length} 个是「${lastPrompt}」）。`,
        `请接着往下写，从第 ${from} 个镜头写到第 ${want} 个，正好再写 ${need} 个；不要重复已经出现过的镜头。`,
        wantDuration > 0 ? `每个镜头的 duration_s 都写成 ${wantDuration}。` : "",
        '只输出 JSON：{"shots":[{"idx":1,"duration_s":5,"shot_type":"","camera_move":"","prompt":"","dialogue":"","audio_hint":""}]}，不要 logline、不要任何解释文字。',
      ].filter(Boolean).join("\n");
      try {
        const out = await generateLlmText(pick, {
          mode: "storyboard", userInput: moreInput, systemPrompt, maxLength,
          temperature: Math.min(0.6, Number(pick.params.temperature) || 0.7),
          timeoutMs: b.timeout_ms || (isExternal ? 180000 : 300000),
          projectId: b.project_id,
          thinking: pick.params.thinking,
        });
        const add = promptLib.normalizeShots(promptLib.extractJson(out.text) || {}, { duration_s: wantDuration });
        const seen = new Set(shots.map((s) => String(s.prompt || "").trim()));
        const fresh = add.filter((s) => {
          const k = String(s.prompt || "").trim();
          if (!k || seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        if (!fresh.length) break;
        text += `\n${out.text}`;
        shots = shots.concat(fresh);
      } catch (e) { lastError = e.message; break; }
    }
    if (want > 0 && shots.length > want) shots = shots.slice(0, want);
    if (want > 0) shots = shots.map((s, i) => ({ ...s, idx: i + 1 }));

    if (!text && lastError) throw err("LLM_FAILED", lastError, 502);
    if (!shots.length) throw err("LLM_PARSE_EMPTY", "模型没有返回可用的分镜 JSON，请重试或更换模型", 502);

    const script = store.script.create({
      projectId: b.project_id, logline: parsed.logline || (b.story || "").slice(0, 60),
      fullText: text, shots,
    });
    const rows = shots.map((s) => store.shot.create({
      script_id: script.id, project_id: b.project_id, idx: s.idx, duration_s: s.duration_s,
      shot_type: s.shot_type, camera_move: s.camera_move, prompt: s.prompt, dialogue: s.dialogue, audio_hint: s.audio_hint,
    }));
    const note = want > 0
      ? (shots.length === want
        ? `已按你填的 ${want} 个镜头拆分${wantDuration > 0 ? `（单镜 ${wantDuration} 秒）` : ""}`
        : `你要 ${want} 个镜头，模型这次只写全了 ${shots.length} 个${truncated ? "（输出被 token 上限截断）" : ""}，已按实际数量保存：可以把「单镜时长」调大、把镜头数调小，或换个模型再试。`)
      : null;
    ok(res, {
      job_id: jobId, script, shots: rows, raw: text, llm: llmMeta(pick),
      requested_shots: want || null, shot_count: rows.length, truncated, note,
    });
  }));
  app.get("/api/scripts", wrap(async (req, res) => ok(res, store.script.list(req.query.project_id))));
  app.get("/api/scripts/:id", wrap(async (req, res) => {
    const s = store.script.get(req.params.id);
    if (!s) throw err("NOT_FOUND", "剧本不存在", 404);
    ok(res, { ...s, shots: store.shot.list(s.id) });
  }));
  app.patch("/api/scripts/:id", wrap(async (req, res) => ok(res, store.script.update(req.params.id, req.body || {}))));
  app.patch("/api/shots/:id", wrap(async (req, res) => {
    const s = store.shot.update(req.params.id, req.body || {});
    if (!s) throw err("NOT_FOUND", "分镜不存在", 404);
    ok(res, s);
  }));

  // --------------------------------------------------------------- API-09 任务
  app.post("/api/jobs", wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.workflow_id) throw err("PARAM_INVALID", "缺少 workflow_id");
    if (!getWorkflow(b.workflow_id)) throw err("WORKFLOW_NOT_FOUND", `未知工作流 ${b.workflow_id}`, 404);
    const job = await jobs.submit({
      workflowId: b.workflow_id, projectId: b.project_id || null, shotId: b.shot_id || null,
      userId: req.user?.id || null, params: b.params || {}, title: b.title,
    });
    ok(res, { job_id: job.id, status: job.status, workflow_id: job.workflow_id });
  }));
  app.get("/api/jobs", wrap(async (req, res) => ok(res, store.job.list({ projectId: req.query.project_id, status: req.query.status, limit: Number(req.query.limit || 100) }))));
  app.get("/api/jobs/:id", wrap(async (req, res) => {
    const j = store.job.get(req.params.id);
    if (!j) throw err("NOT_FOUND", "任务不存在", 404);
    ok(res, { ...j, assets: store.asset.byJob(j.id).map((a) => a), events: store.event.list(j.id, 60) });
  }));
  app.post("/api/jobs/:id/cancel", wrap(async (req, res) => ok(res, await jobs.cancel(req.params.id))));
  app.get("/api/jobs/:id/text", wrap(async (req, res) => ok(res, { text: await jobs.readJobText(req.params.id) })));

  // -------------------------------------------------------------- API-13 素材
  app.get("/api/assets", wrap(async (req, res) => {
    // 筛选条件只认白名单 / 非空值。
    // 前端历史上会把 undefined 拼成字符串传上来（kind=undefined、project_id=null），
    // 后端拿它做等值匹配的结果是「一条都查不到」——素材库点「全部」空的根因，这里兜住。
    const unset = (v) => (!v || v === "null" || v === "undefined" ? undefined : v);
    const kind = ["image", "video", "audio", "file", "text"].includes(req.query.kind) ? req.query.kind : undefined;
    ok(res, store.asset.list({
      projectId: unset(req.query.project_id), kind, limit: Number(req.query.limit || 200),
    }));
  }));
  // 删除单个素材：走批量那条通道，磁盘文件一并清掉（返回值里带 deleted / files 计数）
  app.delete("/api/assets/:id", wrap(async (req, res) => {
    const r = await removeAssets([req.params.id]);
    if (!r.deleted) throw err("NOT_FOUND", "素材不存在", 404);
    ok(res, r);
  }));
  // 批量删除（素材库「删除选中 / 全选」）：一次请求删一批，并顺手清理磁盘文件
  app.post("/api/assets/delete", wrap(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).filter(Boolean))];
    if (!ids.length) throw err("PARAM_INVALID", "请先选择要删除的素材");
    ok(res, await removeAssets(ids));
  }));

  // --------------------------------- API-13a 素材压缩（按目标大小压，本机 ffmpeg，附录 AG）
  //
  // 「平台只让传 10MB」这类需求：视频走两遍 ABR（先统计再出片，大小可控），音频走 CBR mp3。
  // 全部在本机用 ffmpeg 完成，不占 222 的显存；3 分钟 720p 视频约 7 秒。
  // 产物登记成**新素材**（<项目名称>_视频_000x.mp4），原素材原样保留，压糊了能退回去重压。
  app.get("/api/compress/presets", wrap(async (_req, res) => ok(res, {
    presets: compress.presets(), default_mb: compress.DEFAULT_TARGET_MB,
  })));

  app.post("/api/assets/:id/compress", wrap(async (req, res) => {
    const b = req.body || {};
    const a = store.asset.get(req.params.id);
    if (!a) throw err("ASSET_NOT_FOUND", `素材不存在：${req.params.id}`, 404);
    const projectId = b.project_id || a.project_id || null;
    // 先算方案：目标太小（码率低于可用下限）会在这里直接拦下来，给出建议的最小体积
    const p = await compress.plan({
      asset: a, targetMB: b.target_mb, maxHeight: b.max_height, audioKbps: b.audio_kbps, preset: b.preset,
    });
    const { job, assets } = await jobs.runLocal({
      workflowId: "WF-36L", projectId, title: `压缩素材 · ${path.basename(a.path || "")}`,
      params: {
        refs: { source: a.id },
        target_mb: p.targetMB, max_height: p.outHeight || 0, audio_kbps: p.audioKbps,
      },
      run: (j) => compress.compress({
        asset: a, jobId: j.id, projectId,
        targetMB: b.target_mb, maxHeight: b.max_height, audioKbps: b.audio_kbps,
        preset: b.preset, force: b.force === true,
      }),
    });
    const out = assets[0] || null;
    ok(res, {
      job_id: job.id,
      asset: out || null,
      url: out?.url || null,
      kind: out?.kind || p.kind,
      source_asset_id: a.id,
      source_bytes: p.srcBytes,
      compressed_bytes: out?.size_bytes ?? null,
      saved_bytes: out?.size_bytes != null ? Math.max(0, p.srcBytes - out.size_bytes) : null,
      target_mb: p.targetMB,
      within_target: out?.meta?.compressed?.within_target ?? null,
      video_kbps: p.isAudio ? null : p.videoKbps,
      audio_kbps: p.audioKbps,
      width: out?.width ?? null,
      height: out?.height ?? null,
      seconds: p.seconds,
      note: out?.meta?.note || "",
    });
  }));

  // ------------------------------------------------------- API-14 单分镜生成
  app.post("/api/shots/:id/generate", wrap(async (req, res) => {
    const b = req.body || {};
    ok(res, await storyboard.runShot(jobs, req.params.id, b));
  }));

  // --------------------------------------------- API-15 一键多镜头批量生成
  app.post("/api/projects/:id/storyboard/run", wrap(async (req, res) => {
    const b = req.body || {};
    ok(res, await storyboard.runProject(jobs, req.params.id, b));
  }));
  app.post("/api/projects/:id/storyboard/run-async", wrap(async (req, res) => {
    const b = req.body || {};
    storyboard.runProject(jobs, req.params.id, b).catch((e) => log.warn(`分镜批量任务异常: ${e.message}`));
    ok(res, { started: true, project_id: req.params.id });
  }));

  // ------------------------------------------------------------ API-16 成片导出
  // 拼接默认在本机用 ffmpeg 做（src/concat.js）：
  //   · 片段顺序完全按前端排好的数组来；
  //   · 分辨率 / 帧率 / 音轨不一致的片段自动对齐，不劳用户操心；
  //   · 不再把成片上传回 222 —— 那条路会撞 ComfyUI 单请求 100MB 上限（HTTP 413），
  //     而且拼接本身不吃显存，没必要挤 GPU 队列。
  // 想用 222 上的 ConcatenateVideo（WF-16）时传 engine: "comfy"。
  app.post("/api/export/final", wrap(async (req, res) => {
    const b = req.body || {};
    const assets = b.asset_ids?.length
      ? b.asset_ids.map((id) => store.asset.get(id)).filter(Boolean)
      : store.asset.list({ projectId: b.project_id }).filter((a) => a.kind === "video");
    if (!assets.length) throw err("NO_ASSET", "没有可用于合成的视频素材");
    const bad = assets.find((a) => a.kind !== "video");
    if (bad) throw err("PARAM_INVALID", "拼接成片只接受视频素材（收到 " + bad.kind + "）");
    const audios = (b.audio_asset_ids || []).map((id) => store.asset.get(id)).filter(Boolean);
    const bgm = audios[0] || null;
    const durationS = assets.reduce((s, a) => s + (a.duration_ms || 5000) / 1000, 0);

    if (b.engine === "comfy") {
      const job = await jobs.submit({
        workflowId: "WF-16", projectId: b.project_id || null,
        params: { refs: { videos: assets.map((a) => a.id), bgm: bgm?.id || null }, duration_s: durationS },
      });
      if (b.subtitles) {
        burnAfterConcat(jobs, { projectId: b.project_id || null, assets, concatJobId: job.id })
          .catch((e) => log.warn(`拼接后烧字幕失败：${e.message}`));
      }
      ok(res, { job_id: job.id, engine: "comfy", segments: assets.length, subtitles: !!b.subtitles });
      return;
    }

    let jobId = null;
    const task = jobs.runLocal({
      workflowId: "WF-16L", projectId: b.project_id || null, title: "拼接成片（本机）",
      params: {
        refs: { videos: assets.map((a) => a.id), bgm: bgm?.id || null },
        hd: !!b.hd, duration_s: durationS, level_audio: b.level_audio !== false,
      },
      onJob: (job) => { jobId = job.id; },
      run: (job) => concat.concatVideos({
        assets, projectId: b.project_id || null, jobId: job.id,
        bgm, hd: !!b.hd, bgmVolume: b.bgm_volume, levelAudio: b.level_audio !== false,
      }),
    });
    task.catch((e) => log.warn(`拼接成片异常：${e.message}`));
    if (b.subtitles) {
      burnAfterConcat(jobs, { projectId: b.project_id || null, assets, concatJobId: jobId })
        .catch((e) => log.warn(`拼接后烧字幕失败：${e.message}`));
    }
    ok(res, {
      job_id: jobId, engine: "local", segments: assets.length, subtitles: !!b.subtitles, hd: !!b.hd,
      note: b.subtitles
        ? "在本机按你排的顺序拼接（不占 222 的显卡），拼好后自动烧字幕；成片和 .srt 都能在任务中心下载"
        : "在本机按你排的顺序拼接，完成即可从任务产物下载无水印 MP4（可直接拖进剪映）",
    });
  }));

  // ------------------------------------------- API-22 视频配音（自填文字）
  // 视频来源二选一：上传（/api/upload）或素材库（asset_id），两者都是 asset 表里的一条 video。
  // 流程：TTS 合成配音（本机 edge-tts 或外部服务）→ 本机 ffmpeg 把音轨挂到画面上。
  // 这一步刻意不经过 ComfyUI：视频流原样复制、只重编码音轨，秒级完成且不吃显存，
  // 视频多长都能合（原因见 src/mux.js 与需求报告 附录 H.4 的 OOM 复盘）。
  app.post("/api/dub", wrap(async (req, res) => {
    const b = req.body || {};
    const videoId = b.video_asset_id || b.video_id || (Array.isArray(b.video_asset_ids) ? b.video_asset_ids[0] : null);
    if (!videoId) throw err("PARAM_INVALID", "请先选择要配音的视频（上传或素材库选择）");
    const video = store.asset.get(videoId);
    if (!video) throw err("ASSET_NOT_FOUND", `视频素材不存在：${videoId}`, 404);
    if (video.kind !== "video") throw err("PARAM_INVALID", `该素材不是视频（kind=${video.kind}）`);

    const text = String(b.text ?? b.script ?? "").trim();
    if (!text) throw err("PARAM_INVALID", "请输入要配音的文字");

    const projectId = b.project_id || video.project_id || null;
    const keepOriginal = b.keep_original !== false;
    const voiceDb = Number.isFinite(Number(b.voice_volume_db)) ? Number(b.voice_volume_db) : 0;
    const originalDb = Number.isFinite(Number(b.original_volume_db)) ? Number(b.original_volume_db) : -14;

    // 1) 先出配音：本机 edge-tts（免费）或用户配置的外部语音服务
    const { asset: audioAsset, voice } = await tts.synthesizeToAsset({
      text, providerId: b.tts_provider || b.provider || null, voice: b.voice,
      rate: b.rate, volume: b.volume, pitch: b.pitch, speed: b.speed,
      projectId,
    });

    // 2) 再合轨：本机 ffmpeg，同步完成（8 分钟的视频大约 7 秒）
    const { job, assets } = await jobs.runLocal({
      workflowId: "WF-26", projectId, title: text.slice(0, 20),
      params: {
        refs: { source_video: video.id, speech: audioAsset.id },
        keep_original: keepOriginal, voice_volume_db: voiceDb, original_volume_db: originalDb,
      },
      run: (j) => mux.dub({
        jobId: j.id, projectId,
        video, audio: audioAsset,
        keepOriginal, originalDb, voiceDb,
      }),
    });
    const out = assets.find((a) => a.kind === "video") || null;
    const kept = !!out?.meta?.keep_original;
    const hadOriginal = !!out?.meta?.had_original_audio;
    ok(res, {
      job_id: job.id,
      asset: out || null,          // 与 /api/assets 同构，前端拿去直接预览/下载
      video_url: out?.url || null,
      video_asset_id: out?.id || null,
      audio_asset_id: audioAsset.id, audio_url: audioAsset.url,
      source_video_asset_id: video.id,
      voice, chars: text.length,
      keep_original: kept,
      had_original_audio: hadOriginal,
      note: kept
        ? "配音已完成：原声压低当背景、和配音混在一起；画面原样复制，画质无损，可直接拖进剪映"
        : hadOriginal
          ? "配音已完成：已用配音替换视频原音轨；画面原样复制，画质无损，可直接拖进剪映"
          : "配音已完成：这段素材本身没有音轨，成品音轨就是这次的配音；画面原样复制，画质无损，可直接拖进剪映",
    });
  }));
  // ------------------------------------------------- API-24 视频 + 音频合成（本地上传音频）
  //
  // 与 /api/dub 的分工：那条是「自己写台词 → TTS 念出来 → 合轨」，音频是现场合成的；
  // 这条不经过语音合成 —— 视频从素材库挑（或先上传），音频**由用户本地上传**，只是把两轨并成一条。
  // 合成同样在本机用 ffmpeg 完成（复制视频流 + 重编码音轨），不占 222 的显存，视频多长都能合。
  app.post("/api/mux", wrap(async (req, res) => {
    const b = req.body || {};
    const videoId = b.video_asset_id || b.video_id || (Array.isArray(b.video_asset_ids) ? b.video_asset_ids[0] : null);
    if (!videoId) throw err("PARAM_INVALID", "请先选择要合成的视频（上传或素材库选择）");
    const video = store.asset.get(videoId);
    if (!video) throw err("ASSET_NOT_FOUND", `视频素材不存在：${videoId}`, 404);
    if (video.kind !== "video") throw err("PARAM_INVALID", `该素材不是视频（kind=${video.kind}）`);

    const audioId = b.audio_asset_id || b.audio_id || (Array.isArray(b.audio_asset_ids) ? b.audio_asset_ids[0] : null);
    if (!audioId) throw err("PARAM_INVALID", "请先上传要合成的音频文件");
    const audio = store.asset.get(audioId);
    if (!audio) throw err("ASSET_NOT_FOUND", `音频素材不存在：${audioId}`, 404);
    if (audio.kind !== "audio") throw err("PARAM_INVALID", `该素材不是音频（kind=${audio.kind}）`);

    const projectId = b.project_id || video.project_id || audio.project_id || null;
    const keepOriginal = b.keep_original !== false;
    const voiceDb = Number.isFinite(Number(b.voice_volume_db)) ? Number(b.voice_volume_db) : 0;
    const originalDb = Number.isFinite(Number(b.original_volume_db)) ? Number(b.original_volume_db) : -14;

    const { job, assets } = await jobs.runLocal({
      workflowId: "WF-25L", projectId, title: `音轨合成 · ${path.basename(audio.path || "audio")}`,
      params: {
        refs: { source_video: video.id, audio: audio.id },
        keep_original: keepOriginal, voice_volume_db: voiceDb, original_volume_db: originalDb,
      },
      run: (j) => mux.dub({
        jobId: j.id, projectId,
        video, audio,
        keepOriginal, originalDb, voiceDb,
      }),
    });
    const out = assets.find((a) => a.kind === "video") || null;
    ok(res, {
      job_id: job.id,
      asset: out || null,
      video_url: out?.url || null,
      video_asset_id: out?.id || null,
      source_video_asset_id: video.id,
      source_audio_asset_id: audio.id,
      audio_name: path.basename(audio.path || ""),
      audio_duration_ms: audio.duration_ms || null,
      video_duration_ms: video.duration_ms || null,
      keep_original: !!out?.meta?.keep_original,
      had_original_audio: !!out?.meta?.had_original_audio,
      note: out?.meta?.keep_original
        ? "合成完成：视频原声压低当背景，和你上传的音频混在一起；画面原样复制、画质无损，可直接拖进剪映"
        : "合成完成：已用你上传的音频替换视频原音轨；画面原样复制、画质无损，可直接拖进剪映",
    });
  }));

  // ------------------------------------------------- API-25 歌词 → 字幕（音视频对齐）
  //
  // 「一段音频 / 视频 + 一份歌词 → 自动算出时间轴并导出标准字幕」。三种对齐方式：
  //   ① timed  —— 歌词自带时间轴（.lrc / .srt），直接用，最准；
  //   ② speech —— 用 ffmpeg silencedetect 找出「有人声的片段」，把歌词按字数铺到人声区间上；
  //   ③ even   —— 整段按字数均分（兜底）。
  // 产物是 .lrc（播放器歌词）/ .srt（视频与剪映通用）/ .ass（烧录用）三份标准格式；
  // 需要的话还能一键烧成硬字幕视频（WF-27，本机 ffmpeg，不占 222 的显存）。
  const LYRICS_MODES = ["auto", "timed", "speech", "even"];
  async function pickLyricsMedia(id) {
    if (!id) throw err("PARAM_INVALID", "请先选择要配字幕的音频或视频（上传或素材库选择）");
    const media = store.asset.get(id);
    if (!media) throw err("ASSET_NOT_FOUND", `素材不存在：${id}`, 404);
    if (media.kind !== "video" && media.kind !== "audio") {
      throw err("PARAM_INVALID", `只有音频或视频能配字幕（当前 kind=${media.kind}）`);
    }
    return media;
  }
  /**
   * 歌词对齐用的「纯人声轨」：先看有没有现成的分离结果 / 缓存，没有再让本机 Demucs 跑一次。
   * 视频素材要先抽音轨，这条路径不折腾；本机正忙、离线、用户明确不用，都返回 null。
   * 拿不到不是错误 —— 对齐会退回"混音探测"，只是没那么准。
   */
  /**
   * 视频 → 音轨文件（按源文件指纹缓存，同一个视频只抽一次）。
   * 抽成 mp3 再交给 Demucs：ComfyUI 的 LoadAudio 只认音频，喂 mp4 会直接报错。
   */
  async function audioTrackOf(video) {
    if (!video?.path || !fss.existsSync(video.path)) return null;
    const st = await fsp.stat(video.path).catch(() => null);
    if (!st) return null;
    const key = crypto.createHash("sha1")
      .update(`${path.resolve(video.path)}|${st.size}|${Math.round(st.mtimeMs)}`).digest("hex").slice(0, 16);
    const dir = path.join(config.paths.data, "cache", "audio-tracks");
    const dest = path.join(dir, `${key}.mp3`);
    if (fss.existsSync(dest) && fss.statSync(dest).size > 1024) return { ...video, path: dest, url: null };
    await fsp.mkdir(dir, { recursive: true });
    const ffmpeg = require("./ffmpeg");
    await ffmpeg.run(["-y", "-i", video.path, "-vn", "-ac", "2", "-ar", "44100", "-b:a", "192k", dest]);
    return fss.existsSync(dest) && fss.statSync(dest).size > 1024 ? { ...video, path: dest, url: null } : null;
  }

  async function stemForMedia(media, b = {}) {
    if (b.use_vocal_stem === false || b.vocal_stem === false) return null;
    try {
      const vocal = require("./vocal");
      const inst = jobs.pool.instances.find((i) => i.id === vocal.LOCAL_INSTANCE) || null;
      if (!inst) return null;
      if (jobs.anyLocalWorkPending && jobs.anyLocalWorkPending(inst.id)) return null;
      // 视频没有独立的音轨文件：先抽一份出来再分离。
      // 以前这里对视频直接 return null，于是「给视频配歌词」永远只能在混音上猜 —— 伴奏一直在响，
      // 切不出气口，时间轴就被按字数摊平，字幕跟歌声差好几秒（本轮实测，见附录 AE）。
      const song = media.kind === "audio" ? media : await audioTrackOf(media);
      if (!song) return null;
      const stem = await vocal.vocalStemFor({ song, inst });
      return stem?.path || null;
    } catch (e) {
      return null;
    }
  }
  const lyricsArgs = async (b, media) => ({
    media, lyrics: b.lyrics ?? b.text ?? b.content,
    mode: LYRICS_MODES.includes(String(b.mode || "").toLowerCase()) ? String(b.mode).toLowerCase() : "auto",
    offsetMs: b.offset_ms, gapMs: b.gap_ms, minMs: b.min_ms, maxMs: b.max_ms,
    noiseDb: b.noise_db, minSilenceS: b.min_silence_s,
    vocalStem: await stemForMedia(media, b),
    useAsr: b.use_asr !== false,             // 有人声轨就用本机 Whisper 逐字对齐（附录 AF）
    reuseSrtPath: b.reuse_srt_path || null,
    title: b.title, projectId: b.project_id || media.project_id || null,
  });
  const lyricsBrief = (r) => ({
    count: r.count, duration_ms: r.durationMs, mode: r.modeUsed, mode_label: r.modeLabel,
    aligned_by: r.alignedBy, confidence: r.confidence,
    source: r.source, offset_ms: r.offsetMs, gap_ms: r.gapMs, min_ms: r.minMs, max_ms: r.maxMs,
    speech_ok: r.speech.ok, speech_segments: r.speech.count, speech_note: r.speech.note,
    asr_used: !!(r.asr && r.asr.used), asr_words: r.asr?.words ?? null, asr_cached: r.asr?.cached ?? null,
    width: r.width, height: r.height,
  });

  // 能力探测：本机 Whisper 逐字对齐是否就绪（前端据此提示「可用 / 还需下载模型」）
  app.get("/api/lyrics/asr/status", wrap(async (req, res) => {
    const st = require("./asr").status();
    ok(res, { ...st, model: st.model ? path.basename(st.model) : null });
  }));

  app.post("/api/lyrics/align", wrap(async (req, res) => {
    const b = req.body || {};
    const media = await pickLyricsMedia(b.media_asset_id || b.asset_id || b.video_asset_id || b.audio_asset_id);
    const r = await lyrics.build(await lyricsArgs(b, media));
    ok(res, {
      ...lyricsBrief(r),
      media: { id: media.id, kind: media.kind, name: path.basename(media.path || ""), url: media.url || null },
      files: r.files,
      srt_text: r.srtText, lrc_text: r.lrcText,
      lines: r.entries.slice(0, 200).map((e) => ({
        start_ms: e.startMs, duration_ms: e.durationMs, time: subtitle.srtTime(e.startMs), text: e.text,
      })),
      job_id: null,
      note: r.confidence === "high"
        ? `已按「${r.modeLabel}」对齐 ${r.count} 行，导出 .lrc / .srt / .ass 三份标准字幕（本机生成，不占显卡）`
        : `已按「${r.modeLabel}」对齐 ${r.count} 行，导出 .lrc / .srt / .ass。这条时间轴是估算的，想更准就让它先在本机分离一次人声再对齐。`,
    });
  }));

  app.post("/api/lyrics/burn", wrap(async (req, res) => {
    const b = req.body || {};
    const media = await pickLyricsMedia(b.media_asset_id || b.asset_id || b.video_asset_id);
    if (media.kind !== "video") {
      throw err("NOT_VIDEO", "字幕要烧进画面，请选一段视频；只有音频的话请用「生成字幕文件」导出 .lrc / .srt", 400);
    }
    const args = await lyricsArgs(b, media);

    const sink = {};
    const { job, assets } = await jobs.runLocal({
      workflowId: "WF-27", projectId: args.projectId, title: `歌词转字幕 · ${path.basename(media.path || "video")}`,
      params: { refs: { source_video: media.id }, from: "lyrics", mode: args.mode, note: "歌词对齐后烧硬字幕" },
      run: (j) => lyrics.burn({ ...args, jobId: j.id, sink }),
    });
    const out = assets.find((a) => a.kind === "video") || null;
    ok(res, {
      job_id: job.id,
      asset: out || null,
      video_url: out?.url || null,
      video_asset_id: out?.id || null,
      srt_url: out?.meta?.subtitle?.url || null,
      lrc: sink.lrc || null,
      subtitle_lines: out?.meta?.subtitle?.lines || null,
      note: "已把歌词烧成硬字幕（本机 ffmpeg 重编码画面、音频直拷），成片旁边另存了 .srt 与 .lrc，可直接拖进剪映",
    });
  }));

  // ------------------------------------- API-25L 重新对齐歌词（原地覆盖，不堆新编号）
  //
  // 出歌 / 重唱自动生成的歌词是"事后算"的：先分离人声、再找人声活动区间、最后按字数铺开。
  // 早期版本只会在混音上找停顿，遇上带伴奏的歌基本等于瞎猜，时间轴会明显偏。
  // 这条接口就是用现在的算法把**同一份歌词**重算一遍，直接覆盖原来的 .lrc / .srt / .ass，
  // 素材库里不会再多出一串同名字幕；歌词文本一个字都不改。
  app.post("/api/assets/:id/realign-lyrics", wrap(async (req, res) => {
    const b = req.body || {};
    const a = store.asset.get(req.params.id);
    if (!a) throw err("ASSET_NOT_FOUND", `素材不存在：${req.params.id}`, 404);
    if (a.kind !== "audio") throw err("PARAM_INVALID", `只有音频素材能重新对齐歌词（当前 kind=${a.kind}）`);
    const job = a.job_id ? store.job.get(a.job_id) : null;
    const text = String(b.lyrics || job?.params?.lyrics || "").trim();
    if (!text) {
      throw err("NO_LYRICS", "这条素材的原任务里没有留下歌词（多半不是「出歌 / 重唱」生成的），没法重新对齐", 400);
    }
    const stem = await stemForMedia(a, b);
    // 任务名多半是「歌词成曲 · YuE2 · [intro] 第一句歌词」这种自动生成的描述串，
    // 直接写进 .lrc 的 [ti:] 会很难看 —— 像名字（短、没有「 · 」分隔）才用，否则退回项目标题。
    const jobTitle = String(job?.params?._title || "").trim();
    const songTitle = jobTitle && jobTitle.length <= 24 && !jobTitle.includes(" · ") ? jobTitle : "";
    const r = await lyrics.build({
      media: a, lyrics: text, mode: "auto",
      vocalStem: stem,                       // 有分离结果 / 缓存就用，拿不到就混音探测
      useAsr: b.use_asr !== false,            // 默认用本机 Whisper 逐字对齐（附录 AF）
      projectId: a.project_id || null,
      title: songTitle,
      reuseSrtPath: a.meta?.subtitle?.files?.srt?.path || null,
    });
    const info = {
      count: r.count, mode: r.modeUsed, mode_label: r.modeLabel,
      aligned_by: r.alignedBy, confidence: r.confidence,
      speech_segments: r.speech.count, speech_note: r.speech.note,
      duration_ms: r.durationMs, files: r.files,
      asr_used: !!(r.asr && r.asr.used), asr_words: r.asr?.words ?? null,
      from: a.meta?.subtitle?.from || "music-realign",
      lrc_url: r.files?.lrc?.url || null, srt_url: r.files?.srt?.url || null, ass_url: r.files?.ass?.url || null,
      realigned_at: new Date().toISOString(),
    };
    store.asset.updateMeta(a.id, { subtitle: info });
    store.event.log({ message: `歌词已重新对齐：${path.basename(a.path || "")} → ${r.count} 行（${r.modeLabel}）` });
    ok(res, {
      asset_id: a.id, ...info,
      first_line_ms: r.entries[0]?.startMs ?? null,
      last_line_ms: r.entries[r.entries.length - 1]?.startMs ?? null,
      note: r.modeUsed === "asr"
        ? `已重新对齐 ${r.count} 行（${r.modeLabel}）：本机 Whisper 听完整条人声轨，逐字贴到真正的开口处，间奏不再被算成演唱时间`
        : (r.confidence === "high"
          ? `已重新对齐 ${r.count} 行（${r.modeLabel}）：这次拿分离出来的人声当标尺，时间轴跟着真正的演唱走`
          : `已重新对齐 ${r.count} 行（${r.modeLabel}）：这次只能在混音上估算；如果这首歌确实有唱，建议先跑一次「人声 / 伴奏分离」再来`),
    });
  }));

    // --------------------------------- API-25M 歌词下载清单（.lrc / .srt / .ass 一次列全、一键打包）
    //
    // 出歌一多，想找「那首歌的歌词」就得在素材库一首首翻：单首的下载按钮是有的，缺的是一张全局的账。
    // 这里补两件事：
    //   GET  /api/lyrics/manifest       —— 清单（音乐页那张「④ 歌词下载清单」；?format=csv 直接给 Excel 表）
    //   POST /api/lyrics/manifest/pack  —— 打包成 zip（按项目建目录，另附 .csv 清单与 .txt 纯文本歌词）
    // 磁盘上已经被删掉的字幕不进清单 —— 宁可少一行，也不给用户一个点了就 404 的死链。
    // 打包产物落在 data/exports/_歌词清单/（在 /files 静态目录下，能直接下载），只保留最近几份。
    const lyricPacksDir = path.join(config.paths.exports, "_歌词清单");
    const LRC_KINDS = ["lrc", "srt", "ass"];

    /** zip 内按「项目名」建目录：一堆 *_字幕_00xx 混在一个平铺列表里根本分不清是哪首歌的 */
    const zipDirOf = (r) => String(r.project_title || "未分项目").replace(/[\\/:*?"<>|]/g, "_").trim() || "未分项目";
    /** 对齐可信度：新产物直接读字段，老产物按对齐方式反推（与前端同一套口径） */
    const confOf = (r) => {
      const a = r.align || {};
      if (a.confidence) return a.confidence;
      if (a.aligned_by === "stem") return "high";
      if (a.mode === "speech") return "medium";
      if (a.mode || a.aligned_by) return "low";
      return "unknown";          // 磁盘上直接扫出来的没这信息，如实标「未登记」，别冒充「按字数均分」
    };
    const CONF_TEXT = {
      high: "对齐可靠（按真人声标尺）", medium: "混音估算，可能偏差几秒",
      low: "按字数均分，仅供参考", unknown: "未登记（直接读磁盘字幕文件）",
    };
    /** 这条字幕配的是什么：平台命名规则是 <项目>_视频 / 音频 / 字幕_NNNN，源文件已经删掉的只能从名字判断 */
    const kindOf = (name, media) => {
      if (media) return /\.(mp4|mov|webm)$/i.test(media) ? "video" : "audio";
      if (/_视频_/.test(name)) return "video";
      if (/_音频_/.test(name)) return "audio";
      return "subtitle";
    };
    const secText = (ms) => {
      const t = Math.round(Number(ms || 0) / 1000);
      return t ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}` : "-";
    };

    /** 从一份字幕文件里数出行数与末行时间：清单上要显示「45 行 · 3:00」，这些从文件本身就能看出来 */
    async function probeSubtitle(files) {
      for (const k of LRC_KINDS) {
        if (!files[k]) continue;
        const text = await fsp.readFile(files[k], "utf8").catch(() => null);
        if (!text) continue;
        if (k === "lrc") {
          const hits = [...text.matchAll(/^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/gm)];
          if (!hits.length) continue;
          const last = hits[hits.length - 1];
          const ms = (Number(last[1]) * 60 + Number(last[2])) * 1000
            + Number(String(last[3] || "0").padEnd(3, "0").slice(0, 3));
          return { lines: hits.length, duration_ms: ms + 2000 };
        }
        if (k === "srt") {
          const blocks = text.trim().split(/\r?\n\r?\n+/).filter((b) => b.includes("-->"));
          if (!blocks.length) continue;
          const m = [...blocks[blocks.length - 1].matchAll(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/g)].pop();
          const ms = m ? ((Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7])) * 1000 + Number(m[8])) : null;
          return { lines: blocks.length, duration_ms: ms };
        }
      }
      return { lines: null, duration_ms: null };
    }

    /** 扫 data/exports 下所有 .lrc / .srt / .ass，按「同目录 + 同主名」聚成一条（一条 = 一份歌词） */
    async function scanSubtitleFiles() {
      const groups = new Map();
      const packsDirName = path.basename(lyricPacksDir);
      const walk = async (dir) => {
        const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of ents) {
          if (e.isDirectory()) {
            if (e.name === packsDirName) continue;                 // 打包目录里的副本不算
            if (e.name.startsWith("_")) continue;                  // 内部自测 / 临时目录，不进清单
            await walk(path.join(dir, e.name));
            continue;
          }
          if (e.name.startsWith("~$")) continue;                 // Office 打开字幕时留下的临时文件
          const ext = path.extname(e.name).toLowerCase();
          if (![".lrc", ".srt", ".ass"].includes(ext)) continue;
          const full = path.join(dir, e.name);
          const base = path.basename(e.name, ext);
          // ComfyUI 每出一段片子都会顺手落一份 job_xxx_00001__sub.srt（多半还是空的）：
          // 那是内部中间件，不是给人下载的歌词，别混进清单里凑数
          if (/^job_[0-9a-z]+_\d+__(?:dub_)?sub$/i.test(base)) continue;
          const key = `${dir}|${base}`;
          if (!groups.has(key)) groups.set(key, { dir, group: base, files: {}, mtime: 0, media: null });
          const g = groups.get(key);
          g.files[ext.slice(1)] = full;
          // 同目录同名的媒体文件（烧字幕出来的 .lrc / .srt 就躺在视频旁边）——清单里给个「打开源文件」
          if (!g.media) {
            for (const mext of [".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a", ".flac"]) {
              const cand = path.join(dir, `${g.group}${mext}`);
              if (fss.existsSync(cand)) { g.media = cand; break; }
            }
          }
          const st = await fsp.stat(full).catch(() => null);
          if (st) g.mtime = Math.max(g.mtime, st.mtimeMs);
        }
      };
      await walk(config.paths.exports);
      return [...groups.values()];
    }

    /** 素材库记录里的字幕 → 一行清单（磁盘上已经删掉的文件不算，免得给用户一个点开就 404 的死链） */
    function assetLyricRow(a) {
      const s = a.meta?.subtitle;
      const files = s?.files;
      if (!s || !files) return null;
      const picked = {};
      for (const k of LRC_KINDS) {
        const f = files[k];
        if (!f?.path) continue;
        try { if (!fss.existsSync(f.path)) continue; } catch { continue; }
        picked[k] = { name: f.name || path.basename(String(f.path)), path: f.path, url: f.url || null };
      }
      if (!Object.keys(picked).length) return null;
      const media = path.basename(String(a.path || ""));
      const fallback = picked.lrc?.path || picked.srt?.path || picked.ass?.path || "";
      const job = a.job_id ? store.job.get(a.job_id) : null;
      return {
        key: `asset:${a.id}`,
        asset_id: a.id, kind: a.kind, source: "asset",
        media_ok: !!(a.path && fss.existsSync(a.path)),           // 音频本身还在不在（不在就别给「预览」）
        media_file: media || null,
        media_name: path.basename(media, path.extname(media)) || path.basename(fallback, path.extname(fallback)),
        project_id: a.project_id || null,
        project_title: a.project_id ? store.project.titleOf(a.project_id) : null,
        duration_ms: a.duration_ms ?? s.duration_ms ?? null,
        lines: s.count ?? null,
        align: {
          mode: s.mode || null, mode_label: s.mode_label || null,
          aligned_by: s.aligned_by || null, confidence: s.confidence || null,
          note: s.speech_note || null, segments: s.speech_segments ?? null,
          from: s.from || null, realigned_at: s.realigned_at || null,
        },
        created_at: a.created_at,
        lyrics_text: String(job?.params?.lyrics || "").trim() || null,   // 原歌词（打包时另存一份 .txt）
        files: picked,
      };
    }

    /**
     * 歌词清单：**以磁盘上的字幕文件为准**，素材库记录只用来补「歌名 / 行数 / 对齐可信度」。
     *
     * 为什么反过来查：字幕文件并不是素材记录（它只是躺在音频旁边），把素材库清空、或删掉那条音频，
     * 三份字幕照样留在磁盘上；只按素材库出清单的话，用户正好在最需要的时候一条都看不到（实测踩过，见附录 AD）。
     */
    async function lyricsManifest() {
      const rows = [];
      const byFile = new Map();
      for (const a of store.asset.list({ limit: 5000 })) {
        const row = assetLyricRow(a);
        if (!row) continue;
        rows.push(row);
        for (const k of LRC_KINDS) if (row.files[k]) byFile.set(path.resolve(row.files[k].path), row);
      }
      for (const g of await scanSubtitleFiles()) {
        if (LRC_KINDS.some((k) => g.files[k] && byFile.has(path.resolve(g.files[k])))) continue;
        const probe = await probeSubtitle(g.files);
        const dirName = path.basename(g.dir);
        const titled = /^p_[0-9a-z]+$/i.test(dirName) ? store.project.titleOf(dirName) : null;
        const files = {};
        for (const k of LRC_KINDS) {
          if (!g.files[k]) continue;
          files[k] = {
            name: path.basename(g.files[k]), path: g.files[k],
            url: `/files/${path.relative(config.paths.data, g.files[k]).split(path.sep).join("/")}`,
          };
        }
        rows.push({
          key: `disk:${path.relative(config.paths.data, path.join(g.dir, g.group)).split(path.sep).join("/")}`,
          asset_id: null,
          kind: kindOf(g.group, g.media),
          source: "disk", media_ok: !!g.media,
          media_url: g.media ? `/files/${path.relative(config.paths.data, g.media).split(path.sep).join("/")}` : null,
          media_file: g.media ? path.basename(g.media) : (files.lrc?.name || files.srt?.name || files.ass?.name),
          media_name: g.group,
          project_id: titled ? dirName : null,
          project_title: titled || (dirName === "noproj" ? "未归属项目" : dirName),
          duration_ms: probe.duration_ms,
          lines: probe.lines,
          align: {
            mode: null, mode_label: "磁盘字幕文件（素材库里已没有这条记录）", aligned_by: null,
            confidence: null, note: null, segments: null, from: "disk", realigned_at: null,
          },
          created_at: g.mtime ? new Date(g.mtime).toISOString() : null,
          lyrics_text: null,
          files,
        });
      }
      return rows.sort((x, y) => String(y.created_at || "").localeCompare(String(x.created_at || "")));
    }

    /** 清单 → CSV（开头带 BOM，Excel 双击打开不乱码；链接用绝对地址，复制出去也能点） */
    function lyricsCsv(rows, origin) {
      const esc = (v) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const full = (u) => (u ? `${origin}${u}` : "");
      const head = ["序号", "歌曲/素材", "项目", "类型", "时长", "时长(秒)", "歌词行数", "对齐方式", "对齐可信度",
        "源文件", ".lrc 歌词", ".srt 字幕", ".ass 烧录用", "纯文本歌词", "生成时间"];
      const lines = [head.map(esc).join(",")];
      rows.forEach((r, i) => lines.push([
        i + 1, r.media_name, r.project_title || "",
        r.kind === "video" ? "视频" : r.kind === "audio" ? "音频" : "字幕",
        secText(r.duration_ms), r.duration_ms ? Math.round(r.duration_ms / 1000) : "", r.lines || "",
        r.align.mode_label || "", CONF_TEXT[confOf(r)] || "", r.media_file,
        full(r.files.lrc?.url), full(r.files.srt?.url), full(r.files.ass?.url),
        r.lyrics_text ? "有" : "无",
        String(r.created_at || "").replace("T", " ").slice(0, 19),
      ].map(esc).join(",")));
      return "\ufeff" + lines.join("\r\n") + "\r\n";
    }

    /** 清单 → 给人看的纯文本（塞进 zip：不打开 Excel 也能一眼看完有哪些歌） */
    function lyricsTxt(rows, at) {
      const nFile = rows.reduce((n, r) => n + LRC_KINDS.filter((k) => r.files[k]).length, 0);
      const out = ["AI 短视频创作台 · 歌词下载清单", `生成时间：${at}`, `共 ${rows.length} 首，${nFile} 个字幕文件`, ""];
      rows.forEach((r, i) => {
        const dir = zipDirOf(r);
        out.push(`${i + 1}. ${r.media_name}${r.project_title ? `（${r.project_title}）` : ""}`);
        out.push(`   时长 ${secText(r.duration_ms)}　歌词 ${r.lines || "-"} 行　${r.align.mode_label || ""}　${CONF_TEXT[confOf(r)] || ""}`);
        for (const k of LRC_KINDS) if (r.files[k]) out.push(`   .${k}　${dir}/${r.media_name}.${k}`);
        if (r.lyrics_text) out.push(`   纯文本歌词　${dir}/${r.media_name}.歌词.txt`);
        out.push("");
      });
      return out.join("\n");
    }

    app.get("/api/lyrics/manifest", wrap(async (req, res) => {
      const rows = await lyricsManifest();
      if (req.query.format === "csv") {
        const csv = lyricsCsv(rows, `${req.protocol}://${req.get("host")}`);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("歌词下载清单.csv")}`);
        return res.send(csv);
      }
      ok(res, {
        count: rows.length,
        file_count: rows.reduce((n, r) => n + LRC_KINDS.filter((k) => r.files[k]).length, 0),
        with_text: rows.filter((r) => r.lyrics_text).length,
        generated_at: new Date().toISOString(),
        rows,
      });
    }));

    app.post("/api/lyrics/manifest/pack", wrap(async (req, res) => {
      const b = req.body || {};
      let rows = await lyricsManifest();
      // 前端筛选后就传 keys（磁盘行没有 asset_id，不能拿它当主键）；都不传则全打包
      const keys = Array.isArray(b.keys) ? b.keys.filter(Boolean).map(String) : [];
      const ids = Array.isArray(b.asset_ids) ? b.asset_ids.filter(Boolean).map(String) : [];
      if (keys.length) {
        const want = new Set(keys);
        rows = rows.filter((r) => want.has(r.key));
      } else if (ids.length) {
        const want = new Set(ids);
        rows = rows.filter((r) => r.asset_id != null && want.has(String(r.asset_id)));
      }
      if (!rows.length) {
        throw err("NO_LYRICS", "还没有带同步歌词的素材：先在上面出一首歌（填了歌词就会自动生成），或到「配音」页用「歌词 → 字幕」生成一份", 400);
      }
      const at = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const stamp = `${at.getFullYear()}${p2(at.getMonth() + 1)}${p2(at.getDate())}-${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}`;
      await fsp.mkdir(lyricPacksDir, { recursive: true });
      const origin = `${req.protocol}://${req.get("host")}`;
      const csv = lyricsCsv(rows, origin);
      const txt = lyricsTxt(rows, at.toISOString().slice(0, 19).replace("T", " "));
      const entries = [{ name: "歌词清单.csv", data: csv }, { name: "歌词清单.txt", data: txt }];
      let missing = 0;
      for (const r of rows) {
        const dir = zipDirOf(r);
        for (const k of LRC_KINDS) {
          const f = r.files[k];
          if (!f) { missing += 1; continue; }
          const buf = await fsp.readFile(f.path).catch(() => null);
          if (buf) entries.push({ name: `${dir}/${r.media_name}.${k}`, data: buf });
          else missing += 1;
        }
        if (r.lyrics_text) entries.push({ name: `${dir}/${r.media_name}.歌词.txt`, data: r.lyrics_text });
      }
      const zipName = `歌词下载清单_${stamp}.zip`;
      const buf = createZip(entries);
      await fsp.writeFile(path.join(lyricPacksDir, zipName), buf);
      const csvName = `歌词下载清单_${stamp}.csv`;
      await fsp.writeFile(path.join(lyricPacksDir, csvName), csv);
      // 每打包一次就多一份，留着会慢慢堆满磁盘：只保留最近 10 个文件（约 5 次打包）
      const olds = (await fsp.readdir(lyricPacksDir).catch(() => []))
        .filter((n) => /^歌词下载清单_\d{8}-\d{6}\.(zip|csv)$/.test(n)).sort().reverse();
      for (const n of olds.slice(10)) await fsp.unlink(path.join(lyricPacksDir, n)).catch(() => {});
      const rel = (n) => `/files/${path.relative(config.paths.data, path.join(lyricPacksDir, n)).split(path.sep).join("/")}`;
      store.event.log({ message: `歌词下载清单已打包：${rows.length} 首 / ${entries.length} 个文件` });
      ok(res, {
        name: zipName, download_url: rel(zipName), csv_url: rel(csvName),
        songs: rows.length, entries: entries.length, bytes: buf.length, missing,
        with_text: rows.filter((r) => r.lyrics_text).length,
        note: `已打包 ${rows.length} 首的歌词（.lrc / .srt / .ass）`
          + `${rows.filter((r) => r.lyrics_text).length ? "，另附纯文本歌词" : ""}`
          + "；解压后按项目分好目录，里面还有一份「歌词清单.csv」可直接用 Excel 打开",
      });
    }));

    // --------------------------------- API-25N 从歌词清单里删除（只删歌词，不动歌）
    //
    // 清单是「以磁盘字幕文件为准」的，所以删除也落到磁盘：
    //   · asset:<id> —— 素材记录上挂着字幕 → 删掉 .lrc / .srt / .ass，并把 meta.subtitle 清掉（歌曲本身保留）
    //   · disk:<相对路径> —— 只有三份字幕躺在磁盘上（素材库里早没这条记录了）→ 直接删文件
    // 只有显式勾「同时删除源素材」时，才连音频 / 视频一起删（走 removeAssets，与素材库同一套清理逻辑）。
    app.post("/api/lyrics/manifest/delete", wrap(async (req, res) => {
      const b = req.body || {};
      const keys = [...new Set((Array.isArray(b.keys) ? b.keys : []).filter(Boolean).map(String))];
      if (!keys.length) throw err("PARAM_INVALID", "请先选择要删除的歌词");
      const alsoMedia = b.also_media === true;
      const dataRoot = path.resolve(config.paths.data) + path.sep;
      const out = { deleted: 0, files: 0, media: 0, missing: [], skipped: [] };

      // 只删「数据目录里的这三类字幕」：路径穿越 / 别的后缀一律拒绝，避免误删成任意文件删除接口
      const dropFile = async (p) => {
        const abs = path.resolve(String(p || ""));
        if (!abs.startsWith(dataRoot)) { out.skipped.push(abs); return false; }
        if (![".lrc", ".srt", ".ass"].includes(path.extname(abs).toLowerCase())) { out.skipped.push(abs); return false; }
        if (!fss.existsSync(abs)) return false;
        try { await fsp.unlink(abs); out.files += 1; return true; }
        catch (e) { log.warn(`歌词文件删除失败 ${abs}: ${e.message}`); out.skipped.push(abs); return false; }
      };

      for (const key of keys) {
        if (key.startsWith("asset:")) {
          const a = store.asset.get(key.slice(6));
          if (!a) { out.missing.push(key); continue; }
          const files = a.meta?.subtitle?.files || {};
          for (const k of LRC_KINDS) {
            const f = files[k];
            if (f?.path) await dropFile(f.path);
          }
          // 清单靠 meta.subtitle 认这条；不清掉，删了文件它还会以「磁盘行」的身份冒出来
          store.asset.updateMeta(a.id, { subtitle: null });
          if (alsoMedia) {
            const r = await removeAssets([a.id]);
            out.media += r.deleted;
          }
          out.deleted += 1;
        } else if (key.startsWith("disk:")) {
          const base = path.resolve(config.paths.data, key.slice(5));
          if (!base.startsWith(dataRoot)) { out.skipped.push(key); continue; }
          const stem = base.replace(/\.(lrc|srt|ass)$/i, "");
          let hit = false;
          for (const ext of LRC_KINDS) {
            const gone = await dropFile(`${stem}.${ext}`);
            hit = gone || hit;
          }
          if (hit) out.deleted += 1; else out.missing.push(key);
        } else {
          out.skipped.push(key);
        }
      }
      if (out.deleted) {
        store.event.log({ message: `歌词清单已删除 ${out.deleted} 条（清掉 ${out.files} 个字幕文件${out.media ? `，连同 ${out.media} 个源素材` : ""}）` });
      }
      log.info(`歌词清单删除：${out.deleted} 条 / ${out.files} 个文件${out.media ? ` / 源素材 ${out.media}` : ""}`);
      ok(res, {
        ...out,
        note: `已删除 ${out.deleted} 条歌词（清掉 ${out.files} 个字幕文件）`
          + (out.media ? `，连同 ${out.media} 个源素材` : "；歌曲 / 视频本身保留")
          + (out.missing.length ? `；${out.missing.length} 条已经不在磁盘上` : ""),
      });
    }));

  // ------------------------------------------- API-23 AI 翻唱（本机 RVC / ACE-Step / Demucs）

  //
  // 全部跑在**本机 192.168.0.128** 的 ComfyUI 上（config.comfy.instances 里 id = comfyui:local）：
  // 换音色（RVC）、整首重唱（ACE-Step 1.5）、人声/伴奏分离（Demucs）三条链路的权重都只在那台机器。
  // 调度层已经做了双向隔离：这些工作流不会被派到 222，222 的通用任务也不会落到本机实例上。
  // 「整首重唱」也要用「风格模仿」预设，所以顺手把音乐页那份清单一起回给前端（避免两个页面各存一份）
  app.get("/api/vocal/status", wrap(async (_req, res) => ok(res, { ...(await vocal.status(pool)), styles: music.STYLE_PRESETS })));

  // 提交一次翻唱：mode = rvc | ace | split，歌曲 = 音频素材（视频素材会自动抽音轨）
  app.post("/api/vocal/cover", wrap(async (req, res) => {
    const r = await vocal.submit({ pool, jobs, body: req.body || {} });
    ok(res, r);
  }));

  // 歌词 / 风格描述：走和创作台同一个 LLM 通道（本地 Qwen 或外部商业模型）
  app.post("/api/vocal/prompt", wrap(async (req, res) => {
    const b = req.body || {};
    const kind = b.kind === "tags" ? "tags" : "lyrics";
    const topic = String(b.topic || b.text || "").trim();
    if (!topic) throw err("PARAM_INVALID", kind === "tags" ? "请先写一句你想要的感觉，例如：深夜emo、失恋后一个人开车" : "请先写一句歌曲主题或故事，例如：毕业那天没说出口的喜欢");
    const pick = resolveLlmSelection({ llm: b.llm, preset: b.preset });
    if (pick.error) throw err("LLM_NOT_FOUND", pick.error, 400);
    const preset = music.getStylePreset(b.style_preset);
    const imitate = String(b.imitate || "").trim();
    const styleLine = [
      preset ? `风格模仿：${preset.label}（${preset.hint}）` : "",
      preset ? `英文风格标签参考：${preset.tags}` : "",
      b.style ? `用户写的风格：${b.style}` : "",
      imitate ? `用户指定的模仿对象：${imitate}` : "",
    ].filter(Boolean).join("\n");
    // 歌词长度跟着成品时长走：60 秒左右至少 26 行，3 分钟以上至少 40 行
    const sec = Number(b.seconds) || 0;
    const minLines = lyricsMinLines(sec);
    const systemPrompt = kind === "tags"
      ? [
        "你是音乐制作人，负责把一句中文需求变成给音乐生成模型用的英文风格标签。",
        "输出要求：一行英文短语，逗号分隔，10-18 个标签。",
        "顺序：曲风（genre）→ 情绪（mood）→ 主要乐器（instrumentation）→ 人声特点（vocal）→ 制作质感（production）。",
        "如果用户给了风格模仿对象（某位歌手或某个曲风），标签必须明显贴合它的编曲与人声特点。",
        "只输出这行标签本身：不要换行、不要编号、不要解释、不要引号。",
      ].join("\n")
      : [
        "你是专业作词人，按用户给的主题写一版能直接唱、长度完整的歌曲歌词。",
        "输出要求：",
        "1. 用 [intro] [verse] [chorus] [bridge] [outro] 这类段落标签分段，方便直接喂给音乐生成模型；",
        "2. 结构要完整：[intro] → [verse] → [chorus] → [verse] → [chorus] → [bridge] → [chorus] → [outro]，两段主歌的歌词必须不一样；",
        `3. 整首不少于 ${minLines} 行（不含段落标签），每段副歌 4-6 行；`,
        "4. 每句 8-15 个字，口语化、押韵、有画面感，不要写成诗朗诵；",
        "5. 只输出歌词本身：不要解释、不要前后加说明、不要 markdown。",
      ].join("\n");
    const { text, jobId } = await generateLlmText(pick, {
      mode: kind === "tags" ? "image_prompt" : "story",
      systemPrompt,
      userInput: kind === "tags"
        ? `主题/感觉：${topic}${styleLine ? `\n${styleLine}` : ""}`
        : `歌曲主题：${topic}${styleLine ? `\n${styleLine}` : ""}${b.mood ? `\n情绪：${b.mood}` : ""}\n成品时长约 ${sec || 180} 秒，请按这个长度写足歌词。`,
      temperature: kind === "tags" ? 0.8 : 0.9,
      maxLength: kind === "tags" ? 500 : lyricsMaxLength(sec),
      projectId: b.project_id || null,
    });
    const out = String(text || "").trim().replace(/^```[a-z]*\n?|```$/g, "").trim();
    if (!out) throw err("LLM_EMPTY", "模型没有产出内容，请重试或换一个模型", 502);
    ok(res, { kind, text: out, llm: llmMeta(pick), job_id: jobId });
  }));

  // ------------------------------------------------------------ AI 创作音乐（需求报告 附录 W）
  // 四条生成链路同样全跑在**本机 192.168.0.128**：MiniMax Music 3 / YuE2 / ACE-Step 的权重只在那台机器上。
  // 调度层已经做了双向隔离（见附录 V.4）：这些工作流不会被派到 222，222 的通用任务也不会落到本机实例。
  app.get("/api/music/status", wrap(async (_req, res) => ok(res, await music.status(pool))));

  // 提交一次音乐创作：mode = mm3（MiniMax）| yue（YuE2）| lock（锁旋律）| ace（ACE-Step）
  app.post("/api/music/create", wrap(async (req, res) => {
    const r = await music.submit({ pool, jobs, body: req.body || {} });
    ok(res, r);
  }));

  // 写词 / 写风格标签 / 写 MiniMax 三段式 caption：走和创作台同一个 LLM 通道（本地或外部模型）
  app.post("/api/music/prompt", wrap(async (req, res) => {
    const b = req.body || {};
    const kind = ["style", "caption"].includes(b.kind) ? b.kind : "lyrics";
    const topic = String(b.topic || b.text || "").trim();
    if (!topic) {
      throw err("PARAM_INVALID", kind === "lyrics"
        ? "请先写一句歌曲主题或故事，例如：毕业那天没说出口的喜欢"
        : "请先写一句你想要的感觉，例如：深夜 emo、一个人开车");
    }
    const pick = resolveLlmSelection({ llm: b.llm, preset: b.preset });
    if (pick.error) throw err("LLM_NOT_FOUND", pick.error, 400);
    const preset = music.getStylePreset(b.style_preset);
    const imitate = String(b.imitate || "").trim();
    const styleLine = [
      preset ? `风格模仿：${preset.label}（${preset.hint}）` : "",
      preset ? `英文风格标签参考：${preset.tags}` : "",
      b.style ? `用户写的风格：${b.style}` : "",
      imitate ? `用户指定的模仿对象：${imitate}` : "",
    ].filter(Boolean).join("\n");
    // 歌词长度跟着成品时长走：60 秒左右至少 26 行，3 分钟以上至少 40 行
    const sec = Number(b.seconds) || 0;
    const minLines = lyricsMinLines(sec);
    const systemPrompt = kind === "lyrics"
      ? [
        "你是专业作词人，按用户给的主题写一版能直接唱、长度完整的歌曲歌词。",
        "输出要求：",
        "1. 用 [intro] [verse] [chorus] [bridge] [outro] 这类段落标签分段，方便直接喂给音乐生成模型；",
        "2. 结构要完整：[intro] → [verse] → [chorus] → [verse] → [chorus] → [bridge] → [chorus] → [outro]，两段主歌的歌词必须不一样；",
        `3. 整首不少于 ${minLines} 行（不含段落标签），每段副歌 4-6 行；`,
        "4. 每句 8-15 个字，口语化、押韵、有画面感，不要写成诗朗诵；",
        "5. 只输出歌词本身：不要解释、不要前后加说明、不要 markdown。",
      ].join("\n")
      : kind === "caption"
        ? [
          "你是音乐制作人，负责把一句中文需求写成给 MiniMax Music 3 用的英文 caption。",
          "输出必须严格是三段，每段一行标题加英文内容，段与段之间空一行：",
          "Global Metadata: 曲风 + BPM + 制作质感",
          "Vocal Details: 人声特点（如果用户明确要纯音乐，就写 Instrumental only, no vocals）",
          "Arrangement: 编曲与段落走向（intro / verse / chorus 怎么走）",
          "如果用户给了风格模仿对象（某位歌手或某个曲风），三段都要明显贴合它的编曲与人声特点。",
          "只输出这三段，不要编号、不要解释、不要引号、不要 markdown。",
        ].join("\n")
        : [
          "你是音乐制作人，负责把一句中文需求变成给音乐生成模型用的英文风格描述。",
          "输出要求：一行英文短语，逗号分隔，10-18 个标签。",
          "顺序：曲风（genre）→ 情绪（mood）→ BPM → 主要乐器（instrumentation）→ 人声特点（vocal）→ 制作质感（production）。",
          "如果用户给了风格模仿对象（某位歌手或某个曲风），标签必须明显贴合它的编曲与人声特点。",
          "只输出这行标签本身：不要换行、不要编号、不要解释、不要引号。",
        ].join("\n");
    const { text, jobId } = await generateLlmText(pick, {
      mode: kind === "lyrics" ? "story" : "image_prompt",
      systemPrompt,
      userInput: kind === "lyrics"
        ? `歌曲主题：${topic}${styleLine ? `\n${styleLine}` : ""}${b.mood ? `\n情绪：${b.mood}` : ""}\n成品时长约 ${sec || 180} 秒，请按这个长度写足歌词。`
        : `需求：${topic}${styleLine ? `\n${styleLine}` : ""}${b.instrumental ? "\n注意：要纯音乐，没有人声" : ""}`,
      temperature: kind === "lyrics" ? 0.9 : 0.8,
      maxLength: kind === "lyrics" ? lyricsMaxLength(sec) : 500,
      projectId: b.project_id || null,
    });
    const out = String(text || "").trim().replace(/^```[a-z]*\n?|```$/g, "").trim();
    if (!out) throw err("LLM_EMPTY", "模型没有产出内容，请重试或换一个模型", 502);
    ok(res, { kind, text: out, llm: llmMeta(pick), job_id: jobId });
  }));

  // 音乐后期（本机 ffmpeg，不占显卡）：多段拼接 / 裁剪 / 变速 / 接长 / 响度归一 / 淡入淡出，同步返回成品
  app.post("/api/music/edit", wrap(async (req, res) => {
    const b = req.body || {};
    const ids = Array.isArray(b.asset_ids) ? b.asset_ids.slice(0, 20) : (b.asset_id ? [b.asset_id] : []);
    if (!ids.length) throw err("PARAM_INVALID", "请先选要处理的音乐（可多选，顺序就是拼接顺序）");
    const clips = [];
    for (const id of ids) {
      const a = store.asset.get(id);
      if (!a) throw err("ASSET_NOT_FOUND", `素材不存在：${id}`, 404);
      if (a.kind === "audio") { clips.push(a); continue; }
      // 选到视频也能用：自动抽音轨（和配音 / 翻唱页同一套处理）
      if (a.kind === "video") { clips.push(await vocal.ensureSongAsset(a, a.project_id || null)); continue; }
      throw err("PARAM_INVALID", `「${a.id}」不是音频素材（kind=${a.kind}）`);
    }
    const ops = {
      trim_start: Number(b.trim_start) || 0,
      trim_seconds: Number(b.trim_seconds) || null,
      speed: Number(b.speed) || 1,
      target_seconds: Number(b.target_seconds) || null,
      gain_db: Number(b.gain_db) || 0,
      fade_in: Number(b.fade_in) || 0,
      fade_out: Number(b.fade_out) || 0,
      normalize: b.normalize !== false,
      loudness: b.loudness || "short_video",
      bitrate: b.bitrate || "320k",
    };
    const projectId = b.project_id || clips[0].project_id || null;
    const suffix = b.suffix || (clips.length > 1 ? "mix" : "edit");
    const { job, assets } = await jobs.runLocal({
      workflowId: "WF-35", projectId, title: `音乐后期 · ${audioTools.planText(ops)}`.slice(0, 60),
      params: { refs: { audio: clips.map((a) => a.id) }, ops },
      run: (j) => audioTools.process({ jobId: j.id, projectId, clips, ops, title: b.title || null, suffix }),
    });
    const out = assets.find((a) => a.kind === "audio") || null;
    ok(res, {
      job_id: job.id, plan: audioTools.planText(ops),
      asset: out || null, audio_url: out?.url || null, audio_asset_id: out?.id || null,
      duration_ms: out?.duration_ms ?? null, sources: clips.map((a) => a.id),
    });
  }));


  // ------------------------------------------------------------ API-17 剪映草稿

  app.post("/api/export/capcut", wrap(async (req, res) => {
    const b = req.body || {};
    const project = b.project_id ? store.project.get(b.project_id) : null;
    const assets = b.asset_ids?.length
      ? b.asset_ids.map((id) => store.asset.get(id)).filter(Boolean)
      : store.asset.list({ projectId: b.project_id });
    if (!assets.length) throw err("NO_ASSET", "项目没有素材");
    const { clips, audios } = capcut.assembleFromAssets(assets);
    if (!clips.length) throw err("NO_VIDEO", "项目里还没有可导入剪映的视频素材");
    const subtitles = [];
    if (project) {
      let t = 0;
      for (const s of store.shot.listByProject(project.id)) {
        if (s.dialogue) subtitles.push({ start: t, end: t + (s.duration_s || 5), text: s.dialogue });
        t += s.duration_s || 5;
      }
    }
    const aspect = config.limits.aspects[project?.aspect || "9:16"];
    const out = await capcut.buildPackage({
      project, clips, audios, subtitles,
      canvas: { width: aspect.outWidth, height: aspect.outHeight },
      fps: config.export.targetFps,
    });
    const draft = store.draft.create({ projectId: project?.id || "noproj", path: out.zipPath });
    const rel = path.relative(config.paths.data, out.zipPath).split(path.sep).join("/");
    store.draft.update(draft.id, { status: "ready" });
    ok(res, { draft_id: draft.id, download_url: `/files/${rel}`, entries: out.entryCount, duration_s: out.totalSec });
  }));

  // -------------------------------------------------------------- API-18 风格
  app.get("/api/styles", wrap(async (req, res) => ok(res, store.style.list(req.query.category))));
  app.post("/api/styles", wrap(async (req, res) => {
    const s = { ...(req.body || {}) };
    if (!s.id) s.id = `style_custom_${crypto.randomBytes(4).toString("hex")}`;
    s.source = "custom";
    store.style.upsert(s);
    ok(res, store.style.get(s.id));
  }));

  // ------------------------------------------------------------ API-19 模板广场
  app.get("/api/templates", wrap(async (req, res) => ok(res, {
    ...templates.list({
      q: req.query.q, category: req.query.category, type: req.query.type,
      supported: req.query.supported === "true" ? true : undefined,
      limit: Number(req.query.limit || 60), offset: Number(req.query.offset || 0),
    }),
    meta: templates.meta(),
  })));

  // ---------------------------------------------------------------- 静态资源
  app.use("/files", express.static(config.paths.data, { maxAge: "1h", fallthrough: true }));
  app.use("/", express.static(path.join(config.ROOT, "public"), { extensions: ["html"] }));

  // ---------------------------------------------------------------- 错误处理
  app.use((req, res) => res.status(404).json({ ok: false, data: null, error: { code: "NOT_FOUND", message: `未实现的路径 ${req.method} ${req.path}` } }));
  // eslint-disable-next-line no-unused-vars
  app.use((e, _req, res, _next) => {
    const status = e.status || 500;
    if (status >= 500) log.error(`${e.message}\n${e.stack || ""}`);
    else log.warn(`${e.code || "ERROR"}: ${e.message}`);
    res.status(status).json({ ok: false, data: null, error: { code: e.code || "INTERNAL", message: e.message, detail: e.detail || null } });
  });

  return app;
}

module.exports = { createApp, BUILTIN_STYLES };
