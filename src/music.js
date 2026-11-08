"use strict";
/**
 * AI 创作音乐服务层（需求报告 附录 W）。
 *
 * 四种玩法全部跑在**本机 192.168.0.128** 的 ComfyUI 上（config 里 id = comfyui:local），
 * 因为只有这台机器有音乐权重（MiniMax Music 3 / YuE2 + SheetSage2 / ACE-Step 1.5）。
 * 「引擎可不可用」「缺哪个权重」都由这台机器的 /object_info 实时核对，不写死。
 */

const config = require("./config");

const log = require("./logger").scope("music");
const store = require("./store");
const vocal = require("./vocal");
const {
  LOCAL_INSTANCE, MM3_DIT, MM3_TEXT, MM3_DAV, YUE_CKPT, YUE_ENCODER, ACE_CKPT, ACE_VAE,
} = require("./workflows.music");

const { STYLE_PRESETS, getStylePreset, composeStyle } = require("./music-styles");


/** 每种玩法的封面信息（前端卡片 / 任务标题都用它） */
const MODES = [
  {
    id: "mm3", workflowId: "WF-31", label: "文生歌曲 · MiniMax Music 3", icon: "🎵",
    desc: "一句话描述风格 + 一段歌词，直接出一首完整的立体声歌曲；歌词留空就出纯音乐（BGM）。",
    needs: [], lyricsOptional: true, seconds: [10, 360], defaultSeconds: 180, etaPerSecond: 3.2,
  },
  {
    id: "yue", workflowId: "WF-32", label: "歌词成曲 · YuE2", icon: "🎼",
    desc: "把你自己写的歌词唱成整首歌，风格用一段自然语言描述（曲风、BPM、乐器、情绪都能写）。",
    needs: ["lyrics"], seconds: [15, 900], defaultSeconds: 180, etaPerSecond: 1.7,
  },
  {
    id: "lock", workflowId: "WF-33", label: "锁旋律改编 · YuE2", icon: "🔒",
    desc: "给它一段参考音乐，先把旋律抽成谱子锁住，再用同一段旋律配你的新词、换风格重新唱一版。",
    needs: ["song", "lyrics"], seconds: [15, 900], defaultSeconds: 180, etaPerSecond: 1.8,
  },
  {
    id: "ace", workflowId: "WF-34", label: "文生歌曲 · ACE-Step 1.5", icon: "⚡",
    desc: "最省显存、最快的一条：给风格标签 + 歌词就出歌，也能顺手选调性和语言（中文歌尤其稳）。",
    needs: ["lyrics"], seconds: [10, 600], defaultSeconds: 180, etaPerSecond: 0.5,
  },
];

/** 各玩法要在实机上核对存在性的节点（缺一个就在页面上置灰并说明） */
const REQUIRED_NODES = {
  mm3: ["MiniMaxMusic3ModelsLoader", "MiniMaxMusic3AudioGenerate", "SaveAudioMP3"],
  yue: ["CheckpointLoaderSimple", "YuE2GenerateMusic", "EmptyYuE2LatentAudio", "ConditioningZeroOut", "KSampler", "VAEDecodeAudio", "SaveAudioMP3"],
  lock: ["LoadAudio", "AudioEncoderLoader", "SheetSage2AudioToABC", "CheckpointLoaderSimple", "YuE2GenerateMusic", "EmptyYuE2LatentAudio", "ConditioningZeroOut", "KSampler", "VAEDecodeAudio", "SaveAudioMP3"],
  ace: ["CheckpointLoaderSimple", "VAELoader", "TextEncodeAceStepAudio1.5", "EmptyAceStep1.5LatentAudio", "ReferenceTimbreAudio", "VAEEncodeAudio", "ConditioningZeroOut", "KSampler", "VAEDecodeAudio", "SaveAudioMP3"],
};

/** 每个玩法要用到的权重（在 /object_info 的枚举里核对，缺哪个就报哪个） */
const REQUIRED_MODELS = {
  mm3: [
    ["MiniMaxMusic3ModelsLoader", "transformer_name", MM3_DIT],
    ["MiniMaxMusic3ModelsLoader", "text_encoder_name", MM3_TEXT],
    ["MiniMaxMusic3ModelsLoader", "dav_name", MM3_DAV],
  ],
  yue: [["CheckpointLoaderSimple", "ckpt_name", YUE_CKPT]],
  lock: [["CheckpointLoaderSimple", "ckpt_name", YUE_CKPT], ["AudioEncoderLoader", "audio_encoder_name", YUE_ENCODER]],
  ace: [["CheckpointLoaderSimple", "ckpt_name", ACE_CKPT], ["VAELoader", "vae_name", ACE_VAE]],
};

function instanceOf(pool) {
  return (pool?.instances || []).find((i) => i.id === LOCAL_INSTANCE) || null;
}

/** 从 /object_info 里取某个节点某个输入的可选列表 */
function enumOptions(oi, node, input) {
  const v = oi?.[node]?.input?.required?.[input];
  const arr = Array.isArray(v?.[0]) ? v[0] : null;
  return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : null;
}

/** 本机 ComfyUI + 四种玩法的可用性（页面状态条 / 卡片置灰都看它） */
async function status(pool) {
  const inst = instanceOf(pool);
  const base = {
    instance: LOCAL_INSTANCE,
    machine: (config.music && config.music.machine) || (config.vocal && config.vocal.machine) || "本机 192.168.0.128",
    url: inst?.url || null,
    online: !!inst?.online,
    nodes: null,
    modes: MODES,
    styles: STYLE_PRESETS,
    models: { minimax_music3: [MM3_DIT, MM3_TEXT, MM3_DAV], yue2: [YUE_CKPT, YUE_ENCODER], ace_step: [ACE_CKPT, ACE_VAE] },
    engines: MODES.map((m) => ({ id: m.id, workflow_id: m.workflowId, available: false, reasons: [] })),
  };
  if (!inst) {
    for (const e of base.engines) e.reasons.push(`配置里没有 ${LOCAL_INSTANCE} 这个实例（本机音乐节点）`);
    return base;
  }
  if (!inst.online) {
    await inst.refreshStats().catch(() => null);
    if (!inst.online) {
      for (const e of base.engines) e.reasons.push(`本机 ComfyUI（${inst.url}）没有响应，音乐创作暂时不可用`);
      return base;
    }
  }
  let oi;
  try {
    oi = await inst.getObjectInfo();
    base.nodes = Object.keys(oi || {}).length;
    base.online = true;
  } catch (err) {
    for (const e of base.engines) e.reasons.push(`无法读取本机节点定义：${err.message}`);
    return base;
  }
  for (const mode of MODES) {
    const entry = base.engines.find((e) => e.id === mode.id);
    for (const n of REQUIRED_NODES[mode.id]) {
      if (!oi[n]) entry.reasons.push(`本机缺少节点 ${n}`);
    }
    for (const [node, input, file] of REQUIRED_MODELS[mode.id]) {
      const opts = enumOptions(oi, node, input);
      if (opts && !opts.includes(file)) entry.reasons.push(`本机缺少权重 ${file}（${node}.${input} 里找不到）`);
    }
    entry.available = entry.reasons.length === 0;
    if (entry.available) entry.reasons.push("就绪：跑在本机 192.168.0.128 上，不占用 222 的显卡");
    entry.eta_per_second = mode.etaPerSecond;
  }
  return base;
}

/** 提交一次音乐创作（四种模式共用；真正干活的是 workflows.music.js 里的图） */
async function submit({ pool, jobs, body = {} }) {
  const modeId = String(body.mode || body.engine || "mm3");
  const mode = MODES.find((m) => m.id === modeId);
  if (!mode) throw Object.assign(new Error(`未知的音乐模式 ${modeId}（可选：${MODES.map((m) => m.id).join(" / ")}）`), { code: "PARAM_INVALID", status: 400 });

  const inst = instanceOf(pool);
  if (!inst) throw Object.assign(new Error(`本机音乐节点（${LOCAL_INSTANCE}）没有配置，无法创作音乐`), { code: "NO_INSTANCE", status: 503 });
  if (!inst.online) {
    await inst.refreshStats().catch(() => null);
    if (!inst.online) {
      throw Object.assign(new Error(`本机 ComfyUI（${inst.url}）没有响应：音乐权重只在这台机器上，222 帮不上忙。请确认本机 ComfyUI 已启动。`), { code: "LOCAL_OFFLINE", status: 503 });
    }
  }

  const st = await status(pool);
  const engine = st.engines.find((e) => e.id === mode.id);
  if (engine && !engine.available) throw Object.assign(new Error(engine.reasons.join("；")), { code: "ENGINE_UNAVAILABLE", status: 400 });

  const lyrics = String(body.lyrics || "").trim();
  const preset = getStylePreset(body.style_preset);
  const userStyle = String(body.style || body.tags || body.caption || "").trim();
  const imitate = String(body.imitate || "").trim();
  const style = composeStyle(preset, userStyle, imitate);
  if (!lyrics && !style) {
    throw Object.assign(new Error("请至少写一句你想要的感觉（风格描述），或者填一段歌词"), { code: "PARAM_INVALID", status: 400 });
  }
  if (mode.needs.includes("lyrics") && !lyrics) {
    throw Object.assign(new Error(`${mode.label} 需要先有歌词：手填，或用「AI 写词」生成一版`), { code: "PARAM_INVALID", status: 400 });
  }
  if (lyrics.length > 4000) throw Object.assign(new Error("歌词太长了（超过 4000 字），请精简后再生成"), { code: "PARAM_INVALID", status: 400 });

  // 锁旋律必须有一段参考音乐；选了视频素材就自动抽音轨
  let song = null;
  if (mode.needs.includes("song")) {
    const songId = body.song_asset_id || body.audio_asset_id || body.asset_id || (Array.isArray(body.asset_ids) ? body.asset_ids[0] : null);
    const raw = songId ? store.asset.get(songId) : null;
    if (!raw) throw Object.assign(new Error("锁旋律改编需要先选一段参考音乐（上传音频，或从素材库挑一个）"), { code: "PARAM_INVALID", status: 400 });
    song = await vocal.ensureSongAsset(raw, body.project_id || raw.project_id || null);
  }

  const projectId = body.project_id || song?.project_id || null;
  const seconds = Number(body.seconds || body.duration_s) || undefined;
  const params = {
    refs: song ? { audio: [song.id] } : {},
    lyrics,
    tags: style,
    style,
    seconds,
    // 预设可以带自己的速度/拍号（例如「第二圆舞曲」是 168 BPM、3/4 拍）。
    // 请求里显式给了就以请求为准（翻唱页的 BPM 滑杆走这条路）。
    bpm: Number(body.bpm) || Number(preset?.bpm) || 96,
    language: String(body.language || "zh"),
    keyscale: String(body.keyscale || "C major"),
    timesignature: String(body.timesignature || preset?.timesignature || "4"),
    steps: body.steps === undefined ? undefined : Number(body.steps),
    cfg: body.cfg === undefined ? undefined : Number(body.cfg),
    seed: body.seed === undefined ? -1 : Number(body.seed),
    guidance_scale: body.guidance_scale === undefined ? undefined : Number(body.guidance_scale),
    decode_mode: body.decode_mode ? String(body.decode_mode) : undefined,
    temperature: body.temperature === undefined ? undefined : Number(body.temperature),
    repetition_penalty: body.repetition_penalty === undefined ? undefined : Number(body.repetition_penalty),
    use_reference: body.use_reference !== false,
  };
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];

  const title = body.title || (lyrics
    ? `${mode.label} · ${String(lyrics).replace(/\s+/g, " ").slice(0, 24)}`
    : `${mode.label} · ${style.slice(0, 24) || "纯音乐"}`);
  const job = await jobs.submit({ workflowId: mode.workflowId, projectId, params, title });
  const sec = seconds || mode.defaultSeconds || 180;
  log.info(`AI 创作音乐已提交：${mode.workflowId} job=${job.id} 时长=${sec}s 歌词=${lyrics.length}字`);

  return {
    job_id: job.id, mode: mode.id, workflow_id: mode.workflowId, engine: mode.label,
    song_asset_id: song?.id || null, song_url: song?.url || null,
    extracted_from: null, instance: LOCAL_INSTANCE,
    params: { seconds: sec, lyrics_chars: lyrics.length, style: style.slice(0, 160), steps: params.steps ?? null, style_preset: preset ? preset.id : null },
    eta_seconds: Math.round(sec * (mode.etaPerSecond || 2)) + 15,
    note: mode.id === "mm3"
      ? "正在本机出歌：MiniMax Music 3 会先把人声和伴奏一起写出来，大约要等「成品秒数 × 3」。它给的是时长上界，偶尔会提前收尾；不够长可以在 ③ 音乐后期里接长。"
      : mode.id === "yue"
        ? "正在本机出歌：YuE2 按你的歌词演唱，整首生成速度比 MiniMax 快，可以先去任务中心看进度。"
        : mode.id === "lock"
          ? "正在本机改编：先把参考音乐的旋律抽成谱子（SheetSage2），再用同一段旋律配上新词新编曲。"
          : "正在本机出歌：ACE-Step 1.5 最快，通常一两分钟就能听到成品。",
  };
}

/** 音乐后期（本机 ffmpeg）：算一下目标时长，前端用来做提示 */
function editPlan(body = {}) {
  const ops = [];
  if (body.trim_start || body.trim_seconds) ops.push("裁剪");
  if (body.speed && Number(body.speed) !== 1) ops.push(`变速 ${body.speed}x`);
  if (body.target_seconds) ops.push(`接长到 ${body.target_seconds}s`);
  if (body.normalize) ops.push("响度归一");
  if (body.fade_in || body.fade_out) ops.push("淡入淡出");
  return { ops, text: ops.length ? ops.join(" + ") : "原样复制" };
}

module.exports = {
  MODES, STYLE_PRESETS, getStylePreset, composeStyle,
  LOCAL_INSTANCE, status, submit, instanceOf, editPlan,
};