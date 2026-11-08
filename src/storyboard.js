"use strict";
/**
 * 多镜头分镜批量生成（需求报告 §8.17 WF-20 执行 DAG）。
 * 单个 ComfyUI 实例天然串行，因此这里按"逐个分镜、图→视频串行"编排；
 * 多实例时 jobs 队列会自动并行（见 config.comfy.instances）。
 *
 * 视频引擎可由调用方指定（故事创作页的「视频引擎」下拉），默认 WF-15 MiniMax-H3 I2V：
 * 它出的镜头自带声音；横向对比与约束见 resolveVideoWf()。
 */

const store = require("./store");
const tts = require("./tts");
const mux = require("./mux");
const subtitle = require("./subtitle");
const log = require("./logger").scope("storyboard");

const { getWorkflow } = require("./workflows.registry");

/**
 * 「分镜出片」用的视频引擎（故事创作页可切换）。
 *
 * 本页的流水线是「首帧图 → 视频」，所以引擎必须能接首帧（supports.image2video）：
 *   - WF-15 MiniMax-H3 I2V：24fps，**镜头天生带声音**（台词 / 环境音 / 配乐一次生成）→ 默认
 *   - WF-07 Wan 2.2 I2V：16fps、无声，要声音得再勾「带声音」走 TTS 配音
 *   - WF-17 LTX-2.5 AV：24fps、原生音画，长镜头首选
 * 参考驱动（WF-12/15R）、口型驱动（WF-09）、拼接（WF-16）、视频编辑（WF-13）这类
 * 不接首帧的能力在这里直接挡掉，避免在前端选出一个「点了就报缺素材」的引擎。
 */
const DEFAULT_VIDEO_WF = "WF-15";

function resolveVideoWf(id) {
  const wfId = id || DEFAULT_VIDEO_WF;
  const wf = getWorkflow(wfId);
  if (!wf) throw Object.assign(new Error(`未知视频引擎 ${wfId}`), { code: "PARAM_INVALID", status: 400 });
  if (wf.kind !== "video") {
    throw Object.assign(new Error(`视频引擎 ${wfId}（${wf.label}）不是视频类工作流`), { code: "PARAM_INVALID", status: 400 });
  }
  if (!wf.supports?.image2video) {
    throw Object.assign(
      new Error(`视频引擎 ${wfId}（${wf.label}）不能接首帧图，故事创作需要「首帧图 → 视频」的引擎`),
      { code: "PARAM_INVALID", status: 400 });
  }
  // 口型驱动（WF-09 S2V）虽然也吃首帧图，但还要额外喂一条音轨，本流水线不提供，选了必然失败
  if (wf.supports?.audioDriven) {
    throw Object.assign(
      new Error(`视频引擎 ${wfId}（${wf.label}）是口型驱动、需要额外提供音轨；请改选 WF-15（MiniMax，自带声音）/ WF-07 / WF-17 这类引擎`),
      { code: "PARAM_INVALID", status: 400 });
  }
  return wfId;
}
/**
 * 给「原生带声音」的引擎（MiniMax-H3 / LTX-2.5）补一段音频脚本。
 *
 * 这类模型是**音视频联合生成**：对白必须写进提示词，模型才会照着说；只给画面描述时，
 * 它会自己即兴嘟囔一段含混不清的人声——用户反馈的「语音混乱、表达不清晰」就是这么来的。
 * 官方模板的说明原文：prompt —— "describe the shots, motion, and the accompanying audio
 * (dialogue, SFX, music) in one block"。
 *
 * 两种互斥写法，避免出现"两个人在说同一句话"：
 *   ① 走本机 TTS 配音（现在的默认，见 runProject 的 useTts）→ 只让模型出环境音 / 配乐，人声留给 TTS；
 *   ② 用户明确关掉配音 → 把台词原样写进去，让模型自己说，并明确"只有一个人在说话"。
 * 无声引擎（Wan 系）原样返回：它们的画面里本来就不会有人开口。
 */
function withAudioScript(wf, prompt, dialogue, { ttsDub = false, audioHint = null } = {}) {
  const base = String(prompt || "").trim();
  if (!wf?.hasAudio) return base;
  const line = String(dialogue || "").trim();
  const ambient = String(audioHint || "").trim();
  const quiet = `【声音】本镜头只保留与画面匹配的环境音与配乐${ambient ? `（${ambient}）` : ""}。` +
    "不要出现任何人声：不要说话、不要念白、不要哼唱，也不要含糊不清的杂音人声；音频内容只有环境音效与配乐。";
  if (ttsDub) {
    return `${base}\n\n${quiet}（本镜台词由本机配音单独合上，画面里的人物不要开口。）`;
  }
  if (!line) return `${base}\n\n${quiet}`;
  return `${base}\n\n` +
    "【同期对白】画面中说话的角色用中文普通话清晰地念出下面这一句（全片只有这一个人在说话，" +
    `不要叠加其他人的声音、不要合唱、不要旁白）：\n“${line}”\n` +
    "【声音】口齿清楚、语速自然、音量稳定；环境音只做轻微铺垫，不要盖过人声。";
}

const SHOT_TO_CAMERA = {
  static: "static", push: "zoom_in", pull: "zoom_out",
  zoom_in: "zoom_in", zoom_out: "zoom_out",
  pan_left: "pan_left", pan_right: "pan_right", orbit: "orbit", track: "pan_right",
};

class StoryboardRunner extends Error {}

/**
 * 给一个镜头补配音（「带声音」开关打开时用）。
 * 文字来自分镜表的 dialogue 字段，声音由本机 edge-tts 或用户配置的 TTS 服务合成，
 * 再由本机的 src/mux.js 用 ffmpeg 挂到画面上 —— 视频流原样复制、不吃显存，
 * 也不用在 222 上排队（原因见需求报告 附录 H.4）。
 *
 * 返回 { dub_job, voice_asset, voice, dubbed_asset }；如果这镜没有台词则返回 null。
 */
/**
 * 把分镜里的台词整理成「可以直接念出来」的句子。
 *
 * 分镜表的 dialogue 是给人看的，常带说话人标注和舞台提示：
 *   「女孩（笑）：“暑假，正式开始。”」「（内心独白）她走了一年了」
 * 直接丢给 TTS，它会连括号、引号、说话人名字一起念出来，听着就是在念稿子。
 * 所以只给配音用：去掉说话人前缀和括号里的表演提示，留下真正的台词。
 * 字幕仍然用原始文本 —— 观众该看到的是完整的那一句。
 * 清理后如果什么都不剩（比如整句就是「（静默）」），原样返回，别把台词弄没了。
 */
function spokenText(raw) {
  const src = String(raw || "").trim();
  if (!src) return "";
  const t = src
    .replace(/^[^：:（）()]{1,12}[（(][^）)]{0,12}[）)]\s*[：:]\s*/, "")
    .replace(/^[^：:（）()]{1,12}\s*[：:]\s*/, "")
    .replace(/[（(][^）)]{0,20}[）)]/g, "")
    .replace(/[“”"「」『』]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return t || src;
}

async function dubShot(jobs, { shot, projectId, videoAsset, opts }) {
  const text = spokenText(shot.dialogue);
  if (!text || !videoAsset) return null;
  const { asset: audioAsset, voice } = await tts.synthesizeToAsset({
    text,
    providerId: opts.tts_provider || null,
    voice: opts.tts_voice || null,
    rate: opts.tts_rate, volume: opts.tts_volume, pitch: opts.tts_pitch, speed: opts.tts_speed,
    projectId, shotId: shot.id,
  });
  const keepOriginal = opts.keep_original_audio !== false;
  const voiceDb = Number(opts.voice_volume_db ?? 0);
  const originalDb = Number(opts.original_volume_db ?? -14);
  // 本机合成、同步返回：8 分钟的视频大约 7 秒，不需要排队、更不需要等 60 分钟
  const { job, assets } = await jobs.runLocal({
    workflowId: "WF-26", projectId, shotId: shot.id,
    title: "镜头配音",
    params: {
      refs: { source_video: videoAsset.id, speech: audioAsset.id },
      keep_original: keepOriginal, voice_volume_db: voiceDb, original_volume_db: originalDb,
    },
    run: (j) => mux.dub({
      jobId: j.id, projectId, shotId: shot.id,
      video: videoAsset, audio: audioAsset,
      keepOriginal, originalDb, voiceDb,
    }),
  });
  const out = assets.find((a) => a.kind === "video") || null;
  return { dub_job: job.id, voice_asset: audioAsset.id, voice, dubbed_asset: out?.id || null };
}

/**
 * 把这一镜的台词烧成硬字幕（本机 ffmpeg，不占显卡、不用排队）。
 *
 * 有了这一步，「一键生成全部镜头」出来的每条片子直接就能发：画面 + 清晰配音 + 字幕一步到位，
 * 不用再等「③ 拼接成片」那一步才看到字幕。
 *
 * 必须烧在「已经配好音」的那条视频上：字幕只把画面重编码，音轨是直拷的，
 * 先配音后烧字幕才不会把人声丢掉。返回 { subtitle_job, subtitle_asset }；没台词就返回 null。
 */
async function burnShotSubtitle(jobs, { shot, projectId, videoAsset }) {
  const text = String(shot.dialogue || "").trim();
  if (!text || !videoAsset) return null;
  const sec = await mux.videoSeconds(videoAsset).catch(() => 0);
  const durMs = Math.round((sec || Number(shot.duration_s) || 5) * 1000);
  const { job, assets } = await jobs.runLocal({
    workflowId: "WF-27", projectId, shotId: shot.id,
    title: "镜头字幕",
    params: { refs: { source_video: videoAsset.id }, lines: 1 },
    run: (j) => subtitle.burn({
      jobId: j.id, projectId, shotId: shot.id, video: videoAsset,
      entries: [{ text, startMs: 120, durationMs: Math.max(700, durMs - 260) }],
    }),
  });
  const out = assets.find((a) => a.kind === "video") || null;
  return { subtitle_job: job.id, subtitle_asset: out?.id || null };
}

async function runProject(jobs, projectId, opts = {}) {
  const project = store.project.get(projectId);
  if (!project) throw Object.assign(new Error("项目不存在"), { code: "NOT_FOUND", status: 404 });
  const scripts = opts.script_id ? [store.script.get(opts.script_id)] : store.script.list(projectId);
  const script = scripts.filter(Boolean)[0];
  if (!script) throw Object.assign(new Error("该项目还没有剧本，请先生成分镜"), { code: "NO_SCRIPT", status: 400 });
  let shots = store.shot.list(script.id);
  if (!shots.length) throw Object.assign(new Error("分镜表为空"), { code: "NO_SHOTS", status: 400 });
  if (opts.shot_ids?.length) shots = shots.filter((s) => opts.shot_ids.includes(s.id));

  const imageWf = opts.image_workflow || project.meta?.image_workflow || "WF-01B";
  const videoWf = resolveVideoWf(opts.video_workflow || project.meta?.video_workflow);
  const characterIds = opts.character_ids || project.meta?.character_ids || [];
  const styleId = opts.style_id || project.style_id || null;

  const skipped = [];
  const todo = [];
  for (const shot of shots) {
    if (shot.status === "done" && !opts.force) skipped.push({ shot_id: shot.id, skipped: true });
    else todo.push(shot);
  }

  if (!todo.length) return { script_id: script.id, concurrency: 0, shots: skipped };

  const videoWfObj = getWorkflow(videoWf);
  /**
   * 台词交给谁来「说」。
   *
   * MiniMax-H3 / LTX-2.5 这类音视频联合模型，中文对白让它自己念极不稳定：实测经常吐出一段
   * 含混不清、听不懂的人声（用户反馈的「声音乱码」）。所以「自带声音」的引擎改成两条腿走路：
   *   - 模型只出环境音 / 配乐（withAudioScript 会把「不要任何人声」明确写进提示词）；
   *   - 台词交给本机 TTS 合成清晰的中文，再合到画面上（dubShot）。
   * 用户明确关掉配音（with_voice: false）时，才回到「让模型自己念」的老路。
   */
  const useTts = opts.with_voice === true
    || (opts.with_voice == null && !!videoWfObj?.hasAudio);
  const burnSubs = opts.burn_subtitles !== false;

  /** 单镜头流水线：① 文生图首帧 → ② 图生视频 → ③（可选）配音 → ④（可选）烧字幕 */
  const runOneShot = async (shot) => {
    store.shot.update(shot.id, { status: "running" });
    try {
      const imgJob = await jobs.submit({
        workflowId: imageWf, projectId, shotId: shot.id,
        params: {
          prompt: shot.prompt, negative_prompt: shot.negative || undefined,
          aspect: project.aspect, style_id: styleId, character_ids: characterIds,
          shot_type: shot.shot_type, seed: shot.seed ?? undefined,
        },
      });
      const imgDone = await jobs.waitFor(imgJob.id, opts.imageTimeoutMs || 900000);
      if (imgDone.status !== "succeeded") throw new Error(`首帧生成失败：${imgDone.error || "未知原因"}`);
      const firstFrame = store.asset.byJob(imgJob.id).find((a) => a.kind === "image");
      if (!firstFrame) throw new Error("首帧未产出图像");
      const ff = { first_frame: firstFrame.id };
      if (shot.seed !== null && shot.seed !== undefined) ff.seed = shot.seed;
      store.shot.update(shot.id, ff);

      // 引擎原生出声音时：台词写进提示词（或明确要求静音，交给后期 TTS）
      const videoPrompt = withAudioScript(videoWfObj, shot.prompt, shot.dialogue,
        { ttsDub: useTts, audioHint: shot.audio_hint });
      const vidJob = await jobs.submit({
        workflowId: videoWf, projectId, shotId: shot.id,
        params: {
          prompt: videoPrompt, aspect: project.aspect, duration_s: shot.duration_s,
          camera_move: SHOT_TO_CAMERA[shot.camera_move] || shot.camera_move,
          style_id: styleId, character_ids: characterIds,
          refs: { start_image: firstFrame.id },
        },
      });
      const vidDone = await jobs.waitFor(vidJob.id, opts.videoTimeoutMs || 3600000);
      if (vidDone.status !== "succeeded") throw new Error(`视频生成失败：${vidDone.error || "未知原因"}`);

      // ③（可选）带声音：把这一镜的台词合成配音，再挂到刚生成的画面上
      const videoAsset = store.asset.byJob(vidJob.id).find((a) => a.kind === "video");
      let dub = null; let dubError = null;
      if (useTts) {
        try {
          dub = await dubShot(jobs, { shot, projectId, videoAsset, opts });
        } catch (e) {
          dubError = e.message;
          log.warn(`分镜 ${shot.id} 配音失败（视频保留）: ${e.message}`);
        }
        // 这一镜没有台词时 dubShot 返回 null：不能把满档原声原样留着 ——
        // 旁边「配过音」的镜头是「原声 -14dB + 人声 0dB」，这一镜却还是满档原声又没有人声，
        // 拼在一起就是「几种混音混着放、音量忽大忽小」。这里同样把原声压到配音镜头的档位。
        // 源视频本身没有音轨时（Wan 2.2 这类无声引擎）根本没有原声可压：直接跳过，连任务都不要建，
        // 否则任务中心会平白多出一条「失败：源视频没有音轨」的红字（全程无声本来就是一致的）。
        if (!dub && !dubError && videoAsset && await mux.hasAudioTrack(videoAsset)) {
          try {
            const originalDb = Number(opts.original_volume_db ?? -14);
            const lv = await jobs.runLocal({
              workflowId: "WF-26", projectId, shotId: shot.id,
              title: "镜头原声对齐（无台词）",
              params: { refs: { source_video: videoAsset.id }, original_volume_db: originalDb },
              run: (j) => mux.regain({ jobId: j.id, projectId, shotId: shot.id, video: videoAsset, originalDb }),
            });
            const leveledAsset = lv.assets.find((a) => a.kind === "video") || null;
            if (leveledAsset) dub = { dub_job: lv.job.id, leveled_asset: leveledAsset.id, voice: null };
          } catch (e) {
            log.warn(`分镜 ${shot.id} 原声对齐失败（保留原声）: ${e.message}`);
          }
        }
      }
      // ④（可选）台词烧成硬字幕：抖音那种「一句台词一行字幕」的观感。
      // 这一步是本机 ffmpeg（不吃显存、不排队），失败也只是少一层字幕，绝不能把已经出好的视频判失败。
      let sub = null; let subError = null;
      if (burnSubs && String(shot.dialogue || "").trim() && !dubError) {
        try {
          const baseAsset = (dub?.dubbed_asset && store.asset.get(dub.dubbed_asset)) || videoAsset;
          sub = await burnShotSubtitle(jobs, { shot, projectId, videoAsset: baseAsset });
        } catch (e) {
          subError = e.message;
          log.warn(`分镜 ${shot.id} 烧字幕失败（视频保留）: ${e.message}`);
        }
      }
      store.shot.update(shot.id, { status: "done", ...(dubError ? { meta: { dub_error: dubError } } : {}) });
      return { shot_id: shot.id, image_job: imgJob.id, video_job: vidJob.id, ...(dub || {}), ...(sub || {}),
        ...(dubError ? { dub_error: dubError } : {}), ...(subError ? { subtitle_error: subError } : {}), ok: true };
    } catch (err) {
      log.warn(`分镜 ${shot.id} 生成失败: ${err.message}`);
      store.shot.update(shot.id, { status: "failed", meta: { error: err.message } });
      return { shot_id: shot.id, ok: false, error: err.message };
    }
  };

  // 并发度：默认铺满 222 上所有空闲 GPU 槽位（4 卡 = 4 个镜头同时做）
  // 注意：一个镜头内部「先出图再出视频」是串行的，跨镜头才是并行的。
  const auto = (typeof jobs.pool?.parallelSlots === "function" ? jobs.pool.parallelSlots() : 1) || 1;
  const limit = Math.max(1, Math.min(Math.floor(Number(opts.concurrency) || auto), todo.length));

  const results = new Array(todo.length);
  let cursor = 0;
  let aborted = false;
  const worker = async () => {
    for (;;) {
      if (aborted) return;
      const idx = cursor++;
      if (idx >= todo.length) return;
      results[idx] = await runOneShot(todo[idx]);
      if (!results[idx].ok && !opts.continue_on_error) { aborted = true; return; }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));

  const done = results.filter(Boolean);
  for (let k = 0; k < results.length; k += 1) {
    if (!results[k]) done.push({ shot_id: todo[k].id, ok: false, error: aborted ? "已中断（前序镜头失败）" : "未执行" });
  }
  log.info(`分镜批量生成完成：${done.filter((r) => r.ok).length}/${todo.length} 成功，并发度 ${limit}`);
  return { script_id: script.id, concurrency: limit, shots: [...skipped, ...done] };
}

/** 单分镜生成（API-14） */
async function runShot(jobs, shotId, opts = {}) {
  const shot = store.shot.get(shotId);
  if (!shot) throw Object.assign(new Error("分镜不存在"), { code: "NOT_FOUND", status: 404 });
  const project = store.project.get(shot.project_id);
  const imageWf = opts.image_workflow || project?.meta?.image_workflow || "WF-01B";
  const videoWf = resolveVideoWf(opts.video_workflow || project?.meta?.video_workflow);
  store.shot.update(shot.id, { status: "running" });
  const imgJob = await jobs.submit({
    workflowId: imageWf, projectId: shot.project_id, shotId: shot.id,
    params: { prompt: shot.prompt, aspect: project?.aspect || "9:16", style_id: opts.style_id || project?.style_id,
      shot_type: shot.shot_type, character_ids: opts.character_ids || project?.meta?.character_ids || [] },
  });
  const imgDone = await jobs.waitFor(imgJob.id, opts.imageTimeoutMs || 900000);
  if (imgDone.status !== "succeeded") {
    store.shot.update(shot.id, { status: "failed" });
    return { image_job: imgJob.id, ok: false, error: imgDone.error };
  }
  const firstFrame = store.asset.byJob(imgJob.id).find((a) => a.kind === "image");
  if (!firstFrame) return { image_job: imgJob.id, ok: false, error: "首帧未产出" };
  const videoWfObj = getWorkflow(videoWf);
  // 与 runProject 一致：自带声音的引擎默认改走本机 TTS 配音（模型自己念中文极不稳定，会出「乱码」人声）
  const useTts = opts.with_voice === true || (opts.with_voice == null && !!videoWfObj?.hasAudio);
  // 引擎原生出声音时：台词写进提示词（或明确要求静音，交给后期 TTS）
  const videoPrompt = withAudioScript(videoWfObj, shot.prompt, shot.dialogue,
    { ttsDub: useTts, audioHint: shot.audio_hint });
  const vidJob = await jobs.submit({
    workflowId: videoWf, projectId: shot.project_id, shotId: shot.id,
    params: { prompt: videoPrompt, aspect: project?.aspect || "9:16", duration_s: shot.duration_s,
      camera_move: SHOT_TO_CAMERA[shot.camera_move] || shot.camera_move, refs: { start_image: firstFrame.id },
      style_id: opts.style_id || project?.style_id, character_ids: opts.character_ids || project?.meta?.character_ids || [] },
  });
  const vidDone = await jobs.waitFor(vidJob.id, opts.videoTimeoutMs || 3600000);
  let dub = null; let dubError = null; let sub = null; let subError = null;
  if (vidDone.status === "succeeded") {
    const videoAsset = store.asset.byJob(vidJob.id).find((a) => a.kind === "video");
    if (useTts) {
      try {
        dub = await dubShot(jobs, { shot, projectId: shot.project_id, videoAsset, opts });
      } catch (e) {
        dubError = e.message;
        log.warn(`分镜 ${shot.id} 配音失败（视频保留）: ${e.message}`);
      }
    }
    if (opts.burn_subtitles !== false && !dubError) {
      try {
        const baseAsset = (dub?.dubbed_asset && store.asset.get(dub.dubbed_asset)) || videoAsset;
        sub = await burnShotSubtitle(jobs, { shot, projectId: shot.project_id, videoAsset: baseAsset });
      } catch (e) {
        subError = e.message;
        log.warn(`分镜 ${shot.id} 烧字幕失败（视频保留）: ${e.message}`);
      }
    }
  }
  store.shot.update(shot.id, { status: vidDone.status === "succeeded" ? "done" : "failed", first_frame: firstFrame.id });
  return { shot_id: shot.id, image_job: imgJob.id, video_job: vidJob.id, ...(dub || {}), ...(sub || {}),
    ...(dubError ? { dub_error: dubError } : {}), ...(subError ? { subtitle_error: subError } : {}),
    ok: vidDone.status === "succeeded", error: vidDone.error };

}

module.exports = { runProject, runShot, dubShot, SHOT_TO_CAMERA, withAudioScript, spokenText, burnShotSubtitle };

