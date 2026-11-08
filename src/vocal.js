"use strict";
/**
 * AI 翻唱服务层（需求报告 附录 V）。
 *
 * 三种玩法都跑在**本机 192.168.0.128** 的 ComfyUI 上（config 里 id = comfyui:local），
 * 因为只有这台机器有对应权重：
 *   · RVC 音色模型 + hubert（models/TTS/RVC、models/TTS/hubert）
 *   · Demucs 人声/伴奏分离（torchaudio HDEMUCS_HIGH_MUSDB_PLUS）
 *   · ACE-Step 1.5（ace_step_1.5_turbo_aio + scragvae_comfyui）
 * 界面上的「音色清单」「引擎是否可用」都来自这台机器的 /object_info，不写死。
 */

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");

const config = require("./config");
const log = require("./logger").scope("vocal");
const store = require("./store");
const ffmpeg = require("./ffmpeg");
const { getStylePreset, composeStyle } = require("./music-styles");
const naming = require("./naming");
const { getWorkflow } = require("./workflows.registry");

/** 本机 ComfyUI 实例 id（config.json → comfy.instances[].id） */
const LOCAL_INSTANCE = (config.vocal && config.vocal.localInstance) || "comfyui:local";

/** 每种玩法的封面信息（前端卡片、任务标题都用它） */
const MODES = [
  {
    id: "rvc", workflowId: "WF-28", label: "换音色翻唱 · RVC", icon: "🎤",
    desc: "保留原来的旋律、节奏和咬字，只把人声换成你选的音色。适合翻唱整首歌、给同一个人做连载。",
    needs: ["song"],
  },
  {
    id: "ace", workflowId: "WF-29", label: "整首重唱 · ACE-Step 1.5", icon: "🎼",
    desc: "按你写的歌词重新唱一遍；给它一段原曲当参考，音色和编曲感会跟着走。可以顺手换曲风。",
    needs: ["lyrics"],
  },
  {
    id: "split", workflowId: "WF-30", label: "人声 / 伴奏分离", icon: "🎚️",
    desc: "把一首歌拆成「纯人声」和「纯伴奏」两条，各存一份到素材库：人声可以再换音色，伴奏可以当口播 BGM。",
    needs: [],
  },
  {
    id: "train", workflowId: "WF-36", label: "训练新音色 · RVC", icon: "🎓",
    desc: "录一段、或传几段你自己的干净人声，本机把它训练成一个 RVC 音色模型；训完这个音色会出现在「换成谁的声音」下拉框里，换音色翻唱、数字人口播都能直接选。",
    needs: ["samples"],
  },
];

/** 各模式要在实机上核对存在性的节点（缺一个就在页面上置灰并说明） */
const REQUIRED_NODES = {
  rvc: ["LoadAudio", "AudioSeparation", "AudioCombine", "AudioAdjustVolume", "LoadRVCModelNode", "RVCEngineNode", "UnifiedVoiceChangerNode", "MergeAudioNode", "SaveAudioMP3"],
  ace: ["CheckpointLoaderSimple", "VAELoader", "TextEncodeAceStepAudio1.5", "EmptyAceStep1.5LatentAudio", "ReferenceTimbreAudio", "VAEEncodeAudio", "ConditioningZeroOut", "KSampler", "VAEDecodeAudio", "SaveAudioMP3"],
  split: ["LoadAudio", "AudioSeparation", "AudioCombine", "SaveAudioMP3"],
  train: ["LoadAudio", "RVCEngineNode", "RVCDatasetPrepNode", "RVCTrainingConfigNode", "UnifiedModelTrainingNode"],
};

/** 训练用的采样率档位 → 需要哪两个预训练底模（G/D）都在才可选 */
const TRAIN_RATES = { "32k": [32000, "f0G32k.pth", "f0D32k.pth"], "40k": [40000, "f0G40k.pth", "f0D40k.pth"], "48k": [48000, "f0G48k.pth", "f0D48k.pth"] };

function instanceOf(pool) {
  return (pool?.instances || []).find((i) => i.id === LOCAL_INSTANCE) || null;
}

/** RVC 音色目录（ComfyUI 离线时也能把清单列出来） */
function rvcDir() {
  return (config.vocal && config.vocal.rvcDir) || "";
}

/** 音色清单：以实机 /object_info 为准，ComfyUI 不在线时退回扫目录 */
async function voices(pool) {
  const out = new Map();
  const put = (item) => { if (item && item.id && !out.has(item.id)) out.set(item.id, item); };
  const inst = instanceOf(pool);
  if (inst) {
    try {
      const oi = await inst.getObjectInfo();
      const opts = oi?.LoadRVCModelNode?.input?.required?.model?.[0];
      if (Array.isArray(opts)) {
        for (const id of opts.filter((o) => typeof o === "string")) {
          put({
            id,
            label: id.startsWith("local:") ? `${id.slice(6)}（本机）` : id.replace(/\.pth$/i, ""),
            local: id.startsWith("local:"),
          });
        }
      }
    } catch (err) {
      log.warn(`读取本机 RVC 音色清单失败：${err.message}`);
    }
  }
  // 目录再扫一遍并合并：**刚训练出来的 .pth 必须立刻能选**，
  // 不能等 ComfyUI 的 object_info 缓存过期（那是 10 分钟，见 config.comfy.objectInfoCacheSeconds）。
  const dir = rvcDir();
  if (dir) {
    try {
      const files = await fsp.readdir(dir);
      for (const f of files) {
        if (!/\.pth$/i.test(f) || /-lowest\.pth$/i.test(f)) continue;
        put({ id: `local:${f}`, label: `${f.replace(/\.pth$/i, "")}（本机）`, local: true });
      }
    } catch { /* 目录不在就算了：渲染引擎自带的音色清单 */ }
  }
  // 反过来的坑：object_info 是**有缓存**的，刚删掉的模型还会挂在清单里，
  // 用户点了就报「音色不在本机清单里」。本机模型一律现查文件在不在。
  const alive = (id) => {
    if (!id.startsWith("local:") || !dir) return true;
    try { return fs.existsSync(path.join(dir, id.slice(6))); } catch { return true; }
  };
  return [...out.values()].filter((v) => alive(v.id));
}

/** 训练音色的前置条件：预训练底模（G/D）在不在，决定哪些采样率可选 */
async function trainInfo() {
  const rates = [];
  const dir = rvcDir();
  const pdir = dir ? path.join(path.dirname(dir), "pretrained_v2") : "";
  if (pdir) {
    try {
      const files = await fsp.readdir(pdir);
      for (const [key, [, g, d]] of Object.entries(TRAIN_RATES)) {
        if (files.includes(g) && files.includes(d)) rates.push(key);
      }
    } catch { /* 没有 pretrained_v2 = 一档都不可用 */ }
  }
  return {
    available: rates.length > 0,
    sample_rates: rates,
    output_dir: dir || "",
    index_dir: dir ? path.join(dir, ".index") : "",
    min_seconds: 60,
    recommend_seconds: 480,
  };
}

/** 本机 ComfyUI + 三种玩法的可用性（页面的状态条 / 置灰逻辑都看它） */
async function status(pool) {
  const inst = instanceOf(pool);
  const base = {
    instance: LOCAL_INSTANCE,
    machine: (config.vocal && config.vocal.machine) || "本机 192.168.0.128",
    url: inst?.url || null,
    online: !!inst?.online,
    modes: MODES,
    voices: [],
    train: { available: false, sample_rates: [], output_dir: rvcDir(), index_dir: "", min_seconds: 60, recommend_seconds: 480 },
    engines: MODES.map((m) => ({ id: m.id, workflow_id: m.workflowId, available: false, reasons: [] })),
  };
  if (!inst) {
    for (const e of base.engines) e.reasons.push(`配置里没有 ${LOCAL_INSTANCE} 这个实例（本机翻唱节点）`);
    return base;
  }
  if (!inst.online) {
    await inst.refreshStats().catch(() => null);
    base.online = !!inst.online;
  }
  if (!inst.online) {
    for (const e of base.engines) e.reasons.push(`本机 ComfyUI（${inst.url}）没有响应，翻唱暂时不可用`);
    return base;
  }
  let oi = null;
  try { oi = await inst.getObjectInfo(); } catch (err) {
    for (const e of base.engines) e.reasons.push(`无法读取本机节点定义：${err.message}`);
    return base;
  }
  base.nodes = Object.keys(oi).length;
  base.voices = await voices(pool);
  base.train = await trainInfo();
  for (const e of base.engines) {
    const miss = (REQUIRED_NODES[e.id] || []).filter((n) => !oi[n]);
    if (e.id === "ace") {
      const ckpts = oi.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
      const vaes = oi.VAELoader?.input?.required?.vae_name?.[0] || [];
      if (!ckpts.includes("ace_step_1.5_turbo_aio.safetensors")) miss.push("权重 ace_step_1.5_turbo_aio.safetensors");
      if (!vaes.includes("scragvae_comfyui.safetensors")) miss.push("音频 VAE scragvae_comfyui.safetensors");
    }
    if (e.id === "rvc" && !base.voices.length) miss.push("RVC 音色模型（models/TTS/RVC/*.pth）");
    if (e.id === "train" && !base.train.available) miss.push("RVC 预训练底模（models/TTS/pretrained_v2 下的 f0G48k.pth + f0D48k.pth）");
    e.available = miss.length === 0;
    e.workflow_label = getWorkflow(e.workflowId)?.label || e.workflowId;
    if (e.id === "rvc") e.voices = base.voices.length;
    if (miss.length) e.reasons.push(`本机 ComfyUI 缺少：${miss.join("、")}`);
    else e.reasons.push("就绪：跑在本机 192.168.0.128 上，不占用 222 的显卡");
  }
  return base;
}

/**
 * 视频素材当歌曲用：ComfyUI 的 LoadAudio 读不了容器里的音轨，
 * 先用本机 ffmpeg 把音轨抽成 mp3、登记成一条 audio 素材，再走正常流程。
 * 只在真的选了视频时才发生，音频素材直接透传。
 */
async function ensureSongAsset(asset, projectId) {
  if (!asset) return null;
  if (asset.kind === "audio") return asset;
  if (asset.kind !== "video") {
    throw Object.assign(new Error(`素材不是音频也不是视频（kind=${asset.kind}），没法当歌曲用`), { code: "PARAM_INVALID", status: 400 });
  }
  const outDir = path.join(config.paths.exports, projectId || asset.project_id || "noproj");
  await fsp.mkdir(outDir, { recursive: true });
  // 同一段视频抽过一次就复用，避免每次提交都在素材库里多堆一条一模一样的音频
  const cached = store.asset.findExtractedFrom(asset.id);
  if (cached && cached.path && fs.existsSync(cached.path)) return cached;
  const dest = await naming.nextAssetPath(outDir, { projectId: projectId || asset.project_id, kind: "audio", ext: ".mp3" });
  await ffmpeg.run(["-y", "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", asset.path, "-vn", "-acodec", "libmp3lame", "-b:a", "192k", dest], { timeoutMs: 600000 });
  const rel = path.relative(config.paths.data, dest).split(path.sep).join("/");
  const created = store.asset.create({
    job_id: asset.job_id || null, project_id: projectId || asset.project_id || null,
    kind: "audio", path: dest, url: `/files/${rel}`, mime: "audio/mpeg",
    size_bytes: fs.existsSync(dest) ? fs.statSync(dest).size : null,
    meta: { source: { extracted_from: asset.id, original: asset.path }, engine: "ffmpeg", workflow_id: null },
  });
  log.info(`从视频素材 ${asset.id} 抽出音轨 → 音频素材 ${created.id}`);
  return created;
}

/** 提交一次翻唱（三种模式共用；真正干活的是 workflows.vocal.js 里的图） */
// ------------------------------------------------- 纯人声轨（歌词 / 字幕对齐用）
//
// 为什么歌词对齐要绕这一道：歌曲全程带伴奏，直接在混音上找"人声停顿"会被鼓点和铺底骗过去
// （实测一首 180 秒的歌只切出 2 段，等于没切），歌词就被均匀铺满全曲、连前奏一起错位。
// 先分离出纯人声再找停顿，标尺才是真的。Demucs 在 5090 上跑一首 3 分钟的歌约 15 秒，

// 而且结果按「文件指纹」缓存，重刷歌词不用再跑第二遍。

/** 人声轨缓存目录 */
function stemCacheDir() { return path.join(config.paths.data, "cache", "vocal-stems"); }

/** 缓存键 = 路径 + 大小 + 修改时间：同一首歌算过就永远命中，歌被换掉自动失效 */
function stemKey(file) {
  const st = fs.statSync(file);
  return crypto.createHash("sha1")
    .update(`${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}`).digest("hex").slice(0, 16);
}

/**
 * 素材库里已经有这首歌的分离结果吗？
 * 出歌时分离出来的人声叫 `<前缀>_vocals_00001.mp3`、原曲叫 `<前缀>_song_00001.mp3`，
 * 按同一个前缀就能对上 —— 有就直接复用，一点算力都不花。
 */
function findStemAsset(song) {
  const src = path.basename(String(song?.meta?.source?.filename || song?.path || ""));
  const prefix = src.replace(/_(song|resing|music|cover|bgm|vocals|instrumental|edit)_\d+(\.[a-z0-9]+)?$/i, "");
  if (!prefix || prefix === src) return null;
  let rows = [];
  try { rows = store.asset.searchBasenamePrefix(prefix, 80); } catch { return null; }
  const hit = rows.find((r) => /vocals/i.test(path.basename(String(r.path || ""))) && r.path && fs.existsSync(r.path));
  return hit ? { path: hit.path, via: "asset" } : null;
}

/**
 * 取「纯人声轨」（歌词对齐的标尺）。按代价从低到高依次尝试：
 *   ① 复用素材库里已经分离过的（免费）
 *   ② 命中本地缓存（免费）
 *   ③ 本机 ComfyUI 现跑一次 Demucs（约十几秒）—— 只在实例确实空着时才动手
 * 任何一步拿不到都返回 null，调用方退回"混音探测"，不影响主流程。
 *
 * @returns {Promise<{path:string, via:"asset"|"cache"|"demucs", cached:boolean}|null>}
 */
async function vocalStemFor({ song, inst = null, timeoutMs = 300000 } = {}) {
  if (!song?.path || !fs.existsSync(song.path)) return null;

  const reused = findStemAsset(song);
  if (reused) return { path: reused.path, via: reused.via, cached: true };

  const dir = stemCacheDir();
  const dest = path.join(dir, `${stemKey(song.path)}.mp3`);
  if (fs.existsSync(dest)) return { path: dest, via: "cache", cached: true };

  if (!inst || !inst.enabled) return null;
  if (!inst.online) {
    await inst.refreshStats().catch(() => null);
    if (!inst.online) return null;
  }
  await inst.refreshQueue().catch(() => null);
  // 队列里还有别人排着的活儿 → 不插队，直接用混音探测：宁可稍微不准，也不拖慢用户手上的事
  if (inst.queueLen > 0) return null;

  const up = await inst.uploadFile(await fsp.readFile(song.path), path.basename(song.path));
  const wf = {
    "1": { class_type: "LoadAudio", inputs: { audio: up.ref } },
    // 0=Bass 1=Drums 2=Other 3=Vocals
    "2": { class_type: "AudioSeparation", inputs: {
      audio: ["1", 0], chunk_fade_shape: "half_sine", chunk_length: 16, chunk_overlap: 0.1 } },
    "3": { class_type: "SaveAudioMP3", inputs: {
      audio: ["2", 3], filename_prefix: `lyrics_vocals_${Date.now().toString(36)}`, quality: "320k" } },
  };
  const t0 = Date.now();
  inst.activeJobs += 1;   // 先把槽位占住：别让调度器以为这张卡空着、把别的任务派过来
  try {
    const pid = (await inst.queuePrompt(wf)).prompt_id;
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 1500));
      const entry = (await inst.getHistory(pid))?.[pid];
      if (!entry) continue;
      const file = Object.values(entry.outputs || {})
        .flatMap((o) => o.audio || []).find((f) => /vocals/i.test(f.filename));
      if (file) {
        const { buffer } = await inst.viewFile({
          filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(dest, buffer);
        log.info(`人声轨已就绪：Demucs 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s → ${dest}`);
        return { path: dest, via: "demucs", cached: false };
      }
      if (entry.status?.status_str === "error") throw new Error("Demucs 节点执行失败");
      if (entry.status?.status_str === "success") throw new Error("分离跑完了但没拿到人声轨");
    }
    throw new Error(`人声分离超时（>${Math.round(timeoutMs / 1000)}s）`);
  } finally {
    inst.activeJobs = Math.max(0, inst.activeJobs - 1);
  }
}

async function submit({ pool, jobs, body = {} }) {
  const modeId = String(body.mode || body.engine || "rvc");
  const mode = MODES.find((m) => m.id === modeId);
  if (!mode) throw Object.assign(new Error(`未知的翻唱模式 ${modeId}（可选：${MODES.map((m) => m.id).join(" / ")}）`), { code: "PARAM_INVALID", status: 400 });

  const inst = instanceOf(pool);
  if (!inst) throw Object.assign(new Error(`本机翻唱节点（${LOCAL_INSTANCE}）没有配置，无法翻唱`), { code: "NO_INSTANCE", status: 503 });
  if (!inst.online) {
    await inst.refreshStats().catch(() => null);
    if (!inst.online) {
      throw Object.assign(new Error(`本机 ComfyUI（${inst.url}）没有响应：翻唱用的 RVC / Demucs / ACE-Step 权重只在这台机器上，222 帮不上忙。请确认本机 ComfyUI 已启动。`), { code: "LOCAL_OFFLINE", status: 503 });
    }
  }

  const st = await status(pool);
  const engine = st.engines.find((e) => e.id === mode.id);
  if (engine && !engine.available) throw Object.assign(new Error(engine.reasons.join("；")), { code: "ENGINE_UNAVAILABLE", status: 400 });

  // 训练音色吃的是「人声样本」而不是「一首歌」，所以这条分支要排在选歌之前
  if (mode.id === "train") return submitTrain({ jobs, body, st });

  const songId = body.song_asset_id || body.audio_asset_id || body.asset_id || (Array.isArray(body.asset_ids) ? body.asset_ids[0] : null);
  const raw = songId ? store.asset.get(songId) : null;
  if (songId && !raw) throw Object.assign(new Error(`歌曲素材不存在：${songId}`), { code: "ASSET_NOT_FOUND", status: 404 });
  if (mode.id !== "ace" || raw) {
    if (!raw) throw Object.assign(new Error("请先选一首歌（上传音频，或从素材库里挑一个）"), { code: "PARAM_INVALID", status: 400 });
  }
  const projectId = body.project_id || raw?.project_id || null;
  const song = raw ? await ensureSongAsset(raw, projectId) : null;

  const lyrics = String(body.lyrics || "").trim();
  if (mode.id === "ace" && !lyrics) {
    throw Object.assign(new Error("整首重唱要先有歌词：手填，或用「AI 写词」生成一版"), { code: "PARAM_INVALID", status: 400 });
  }
  if (mode.id === "ace" && lyrics.length > 4000) {
    throw Object.assign(new Error("歌词太长了（超过 4000 字），请精简后再生成"), { code: "PARAM_INVALID", status: 400 });
  }

  const voiceModel = String(body.voice_model || "").trim();
  if (mode.id === "rvc") {
    const list = st.voices || [];
    if (!voiceModel) throw Object.assign(new Error("请先选一个音色"), { code: "PARAM_INVALID", status: 400 });
    if (list.length && !list.some((v) => v.id === voiceModel)) {
      throw Object.assign(new Error(`音色 ${voiceModel} 不在本机清单里，请重新选择（可能模型被移走了）`), { code: "MODEL_MISSING", status: 400 });
    }
  }

  const refs = { audio: [song.id] };
  const title = body.title || `${mode.label} · ${path.basename(song.path)}`;
  const params = {
    refs,
    voice_model: voiceModel,
    pitch: Number(body.pitch) || 0,
    index_ratio: body.index_ratio === undefined ? 0.75 : Number(body.index_ratio),
    consonant_protection: body.consonant_protection === undefined ? 0.25 : Number(body.consonant_protection),
    volume_envelope: body.volume_envelope === undefined ? 0.25 : Number(body.volume_envelope),
    vocal_gain_db: Number(body.vocal_gain_db) || 0,
    inst_gain_db: Number(body.inst_gain_db) || 0,
    lyrics,
    tags: composeStyle(getStylePreset(body.style_preset), String(body.tags || body.style_tags || "").trim(), String(body.imitate || "").trim()),
    bpm: Number(body.bpm) || 120,
    seconds: Number(body.seconds) || undefined,
    language: String(body.language || "zh"),
    keyscale: String(body.keyscale || "C major"),
    timesignature: String(body.timesignature || "4"),
    steps: Number(body.steps) || 8,
    cfg: body.cfg === undefined ? 1 : Number(body.cfg),
    seed: body.seed === undefined ? -1 : Number(body.seed),
    use_reference: body.use_reference !== false,
  };

  const job = await jobs.submit({ workflowId: mode.workflowId, projectId, params, title });
  log.info(`AI 翻唱已提交：${mode.workflowId} job=${job.id} 歌曲=${song.id} 音色=${voiceModel || "-"}`);
  return {
    job_id: job.id, mode: mode.id, workflow_id: mode.workflowId, engine: mode.label,
    song_asset_id: song.id, song_url: song.url,
    extracted_from: raw && raw.kind === "video" ? raw.id : null,
    instance: LOCAL_INSTANCE, voices: st.voices.length,
    params: { voice_model: voiceModel || null, pitch: params.pitch, bpm: params.bpm, seconds: params.seconds || null, lyrics_chars: lyrics.length },
    note: mode.id === "rvc"
      ? "正在本机换音色：先分离人声与伴奏，再把主唱换成你选的音色，最后混回伴奏。整首歌长度都支持，出片后自动存进素材库。"
      : mode.id === "ace"
        ? "正在本机重唱：按你给的歌词重新演唱，参考音频会带上原来的音色和编曲感。整首生成比换音色慢一些，可以先去任务中心看进度。"
        : "正在本机分离：人声和伴奏各存一条到素材库。",
  };
}

/**
 * 训练一个新音色：把用户录的 / 传的若干段人声拼成一条训练音频，再交给 WF-36。
 *
 * 为什么要先拼接：ComfyUI 的 RVC 数据集节点只吃一条 AUDIO（opt_audio1），
 * 而用户更可能是「录三段 + 传两段」；服务端拼成一条 wav，顺带统一成 48k 单声道，
 * 训练节点拿到的就是干净输入（见需求报告 附录 AK）。
 */
async function submitTrain({ jobs, body, st }) {
  const info = (st && st.train) || {};
  if (!info.available) {
    throw Object.assign(new Error(
      "本机缺少 RVC 预训练底模（models/TTS/pretrained_v2 下的 f0G48k.pth + f0D48k.pth），暂时没法训练新音色"),
      { code: "TRAIN_UNSUPPORTED", status: 400 });
  }

  const name = String(body.voice_name ?? body.name ?? "").trim();
  if (!name) throw Object.assign(new Error("请先给这个音色起个名字，例如：小明 / 我的声音"), { code: "PARAM_INVALID", status: 400 });
  if (name.length > 30) throw Object.assign(new Error("音色名字太长了（30 字以内）—— 它会直接变成模型文件名"), { code: "PARAM_INVALID", status: 400 });

  const ids = (Array.isArray(body.asset_ids) ? body.asset_ids : [body.asset_id || body.sample_asset_id])
    .filter(Boolean);
  if (!ids.length) throw Object.assign(new Error("请先录一段，或上传至少一段人声样本"), { code: "PARAM_INVALID", status: 400 });
  const samples = ids.map((id) => store.asset.get(id)).filter(Boolean);
  if (!samples.length) {
    throw Object.assign(new Error("样本素材不在素材库里了（可能被删过），请重新录 / 重新上传"),
      { code: "ASSET_NOT_FOUND", status: 404 });
  }

  const rateKey = TRAIN_RATES[String(body.sample_rate || "").trim()]
    ? String(body.sample_rate).trim()
    : (info.sample_rates.includes("48k") ? "48k" : (info.sample_rates[0] || ""));
  if (!rateKey) throw Object.assign(new Error("本机没有可用的训练采样率"), { code: "TRAIN_UNSUPPORTED", status: 400 });
  const sr = TRAIN_RATES[rateKey][0];

  const projectId = body.project_id || samples[0].project_id || null;
  const tag = Date.now().toString(36);
  const tmp = path.join(config.paths.data, "cache", "voice-train");
  await fsp.mkdir(tmp, { recursive: true });

  // 1) 每段统一成 48k / 单声道 / pcm wav（浏览器录的 webm、手机传的 m4a 都能在这一步吃进来）
  const parts = [];
  let totalMs = 0;
  for (const [i, a] of samples.entries()) {
    const p = path.join(tmp, `${tag}_${i}.wav`);
    await ffmpeg.run(["-y", "-hide_banner", "-loglevel", "error", "-i", a.path,
      "-vn", "-ac", "1", "-ar", String(sr), "-c:a", "pcm_s16le", p], { timeoutMs: 900000 });
    const dur = await require("./lyrics").probeDurationMs(p).catch(() => 0);
    totalMs += Number(dur) || 0;
    parts.push(p);
  }

  // 2) 多段拼成一条（同格式，直接 concat）
  let merged = parts[0];
  if (parts.length > 1) {
    const listFile = path.join(tmp, `${tag}_list.txt`);
    await fsp.writeFile(listFile, parts.map((p) => `file '${p.split(path.sep).join("/")}'`).join("\n"), "utf8");
    merged = path.join(tmp, `${tag}_merged.wav`);
    await ffmpeg.run(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
      "-i", listFile, "-c", "copy", merged], { timeoutMs: 900000 });
  }
  const seconds = totalMs / 1000;
  if (seconds && seconds < (info.min_seconds || 60)) {
    log.warn(`训练样本只有 ${seconds.toFixed(0)} 秒：能跑，但音色容易不稳（建议 ${info.recommend_seconds || 480} 秒以上）`);
  }

  // 3) 存成素材库的一条音频：留档，下次想再训还能直接复用
  const dir = path.join(config.paths.uploads, projectId || "common");
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `voicetrain_${tag}_${name.replace(/[^\w\-]+/g, "_")}.wav`);
  await fsp.copyFile(merged, dest);
  const stat = await fsp.stat(dest);
  const rel = path.relative(config.paths.data, dest).split(path.sep).join("/");
  const sample = store.asset.create({
    project_id: projectId, kind: "audio", path: dest, url: `/files/${rel}`, mime: "audio/wav",
    duration_ms: Math.round(totalMs) || null, has_audio: true, watermark: false, size_bytes: stat.size,
    meta: {
      voice_train_sample: true, voice_name: name, sample_rate: rateKey,
      parts: samples.length, source_ids: samples.map((s) => s.id),
    },
  });

  const epochs = Math.round(clampNum(body.epochs, 10, 400, 50));
  const params = {
    refs: { audio: [sample.id] },
    voice_name: name,
    sample_rate: rateKey,
    epochs,
    batch_size: Math.round(clampNum(body.batch_size, 1, 16, 4)),
    learning_rate: clampNum(body.learning_rate, 0.000001, 0.01, 0.0001),
    cpu_workers: Math.round(clampNum(body.cpu_workers, 1, 8, 4)),
    reuse_existing: body.reuse_existing !== false,
  };
  const job = await jobs.submit({ workflowId: "WF-36", projectId, params, title: `训练音色 · ${name}（${rateKey}）` });
  log.info(`音色训练已提交：WF-36 job=${job.id} 名字=${name} 样本=${samples.length} 段`
    + `${seconds ? " " + seconds.toFixed(0) + "s" : ""} ${rateKey} ${epochs} 轮`);
  return {
    job_id: job.id, mode: "train", workflow_id: "WF-36", engine: "训练新音色 · RVC",
    voice_name: name, sample_rate: rateKey,
    sample_asset_id: sample.id, sample_url: sample.url,
    samples: samples.length, sample_seconds: Math.round(seconds) || null,
    output_dir: info.output_dir || "", index_dir: info.index_dir || "",
    expected_file: `${name}_${rateKey}.pth`,
    note: `正在本机训练「${name}」：先切片、提特征，再训练 ${epochs} 轮。这事儿要几分钟到几十分钟，`
      + "可以先去任务中心看进度；训完它会自动出现在「换成谁的声音」下拉框里。",
  };
}

/** 数字入参规整（body 里可能是字符串，也可能没传） */
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

module.exports = { MODES, LOCAL_INSTANCE, status, voices, submit, instanceOf, ensureSongAsset, vocalStemFor, submitTrain, trainInfo };
