"use strict";
/**
 * 任务编排核心（需求报告 §4.3 状态机、§4.5 GPU 调度、§7.1 调用时序、§7.6 降级、§7.7 产物回收、§6 API-09/20）。
 *
 * 状态机：queued → dispatching → running → (succeeded | failed | canceled)
 * 完成判定以 /history 轮询为准（WS 只负责进度与预览），避免 WS 断连丢事件。
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const config = require("./config");
const log = require("./logger").scope("jobs");
const store = require("./store");
const naming = require("./naming");
const { getWorkflow, validateWorkflow, normalizeBuiltWorkflow, swapToFp16Vae, usesInt8Vae } = require("./workflows.registry");
const { compose, composeNegative, extractJson } = require("./prompt");

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4",
  txt: "text/plain", json: "application/json", md: "text/markdown", srt: "text/plain",
};
const kindOf = (ext) => {
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (["mp4", "webm", "mkv", "mov"].includes(ext)) return "video";
  if (["mp3", "wav", "flac", "m4a", "ogg"].includes(ext)) return "audio";
  return "text";
};
const alignUp = (v, m) => Math.max(m, Math.round(Number(v) / m) * m);

/** 任务的终态：到了这三个之一就不再变化，等待者可以放行 */
const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

/**
 * 「重活儿」判定：跑完值得尽快把模型卸掉、显存还回去的任务。
 *
 * 视频/音频任务动辄占掉整张卡（MiniMax-H3 是 exclusive 级、40GB+ 权重），
 * 用户要的就是「做完别一直占着」；图片任务反而相反 —— 调一张封面往往连着改几次提示词，
 * 把模型卸掉等于每次都重新加载，所以图片任务不在这一档，交给空闲兜底（sweepIdle）统一回收。
 */
const isHeavyWorkflow = (wf) =>
  !!wf && (wf.kind === "video" || wf.kind === "audio" || wf.vramClass === "exclusive" || wf.vramClass === "heavy");

class JobManager extends EventEmitter {
  constructor(pool) {
    super();
    this.pool = pool;
    this.inflight = new Set();    // 已派发但未到终态的任务 id（多卡并行时同时存在多个）
    this.claimedInst = new Map(); // jobId → 认领时占用的实例 id（release 用它归还槽位，别依赖 job.instance）
    this.uploads = new Map();     // assetId → comfy 文件名（进程级缓存）
    this.log = log;
    this.timer = null;
    this.pumpLock = false;
    this.finalizing = new Set();  // 正在回收产物的任务（防止 WS 事件与巡检并发重复落盘）
    this.orphanTicks = new Map(); // jobId → 连续几次巡检发现它已不在 ComfyUI 队列里
    this.freeing = new Set();     // 正在发 /free 的实例（同一张卡同时只发一次）
    this.freePass = false;        // 回收巡检的互斥锁（多个触发点同时到达时只跑一轮）
    this.releaseAfter = new Map();// instId → 早于这个时间点不考虑释放（冷却，防抖）
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pump().catch((e) => log.warn(`pump 异常: ${e.message}`));
      this.sweep().catch((e) => log.warn(`sweep 异常: ${e.message}`));
    }, 1500);
    // 显存释放的冷却从此刻起算：刚启动时先不动 222 上已有的模型，等真的闲下来再说
    for (const inst of this.pool.instances) this.markUsed(inst.id);
    this.pool.on("event", (ev) => this.onWsEvent(ev));
    this.pool.on("preview-binary", (ev) => this.onPreviewBinary(ev));
    this.resume();
    log.info("任务编排器已启动");
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /**
   * 进程重启后的残留任务处置。
   *
   * 不能一律判失败：MiniMax-H3 的 20 秒一镜在 A6000 上要跑十几分钟（实测 5 秒 / 124 帧
   * 也已经远超 10 分钟），重启网页端时 ComfyUI 那边往往还在采样。老实现是「启动即把所有
   * running 标失败」，等于白扔已经在算的片段，还会让 GPU 空转。
   *
   * 现在按三态处理：
   *   ① /queue 里还在        → 保持 running，sweep() 的 tryFinalize 会在跑完后正常回填产物；
   *   ② /queue 没了但有 /history → 已经算完，同样交给 tryFinalize 收产物；
   *   ③ 两边都没有            → 确实被实例重启/杀掉了，才判失败。
   * 实例当前不可达时不判死，交给 sweep()/checkOrphan() 在实例恢复后处置。
   */
  async resume() {
    // healthTick 是异步的，这里先确保至少探到一次实例状态，否则会把「还在跑」误判成「丢了」
    await this.pool.anyOnline().catch(() => []);
    for (const j of store.job.running()) {
      const inst = j.instance ? this.pool.instances.find((i) => i.id === j.instance) : null;
      if (inst && !inst.online) {
        log.warn(`任务 ${j.id} 所在实例 ${inst.id} 暂不可达，先不改状态（等实例恢复后由巡检判定）`);
        continue;
      }
      let alive = false;
      if (inst && j.prompt_id) {
        try {
          alive = await inst.hasPrompt(j.prompt_id);
          if (!alive) {
            const h = await inst.getHistory(j.prompt_id);
            alive = !!(h && Object.keys(h).length);
          }
        } catch (e) { alive = false; }
      }
      if (alive) {
        // 重新挂回时也要把它占的槽位补记回来：否则重启后这张卡会被当成空闲，
        // 调度器会在同一个 ComfyUI 上再叠一个任务（实测会把卡压到 OOM / 排队）。
        if (inst) {
          inst.activeJobs += 1;
          this.claimedInst.set(j.id, inst.id);
          this.inflight.add(j.id);
        }
        log.info(`任务 ${j.id} 重启后重新挂回 ${j.instance}（ComfyUI 仍在处理，产物照常回填）`);
        continue;
      }
      store.job.update(j.id, { status: "failed", error: "服务重启导致任务中断", finished_at: new Date().toISOString() });
    }
  }

  // ------------------------------------------------------------- 提交 / 取消
  async submit({ workflowId, projectId = null, shotId = null, userId = null, params = {}, title = null }) {
    const wf = getWorkflow(workflowId);
    if (!wf) throw Object.assign(new Error(`未知工作流 ${workflowId}`), { code: "WORKFLOW_NOT_FOUND", status: 400 });
    if (wf.localOnly) {
      throw Object.assign(new Error(
        `${workflowId}（${wf.label}）由本机直接合成、不经过 ComfyUI，请调用对应业务接口（如 /api/dub）；` +
        "它是纯 I/O 的活儿，送到 222 上反而会把整段视频解码进内存。"),
        { code: "LOCAL_ONLY", status: 400 });
    }
    const job = store.job.create({
      workflow_id: workflowId, project_id: projectId, shot_id: shotId, user_id: userId,
      engine: wf.engine, vram_class: wf.vramClass, params: { ...params, _title: title },
    });
    store.event.log({ jobId: job.id, message: `提交任务 ${workflowId}` });
    this.emit("job", { job_id: job.id, type: "status", status: "queued" });
    this.pump().catch(() => {});
    return job;
  }

  async cancel(jobId) {
    const job = store.job.get(jobId);
    if (!job) throw Object.assign(new Error("任务不存在"), { code: "NOT_FOUND", status: 404 });
    if (["succeeded", "failed", "canceled"].includes(job.status)) return job;
    if (job.instance) {
      const inst = this.pool.instances.find((i) => i.id === job.instance);
      try { await inst?.interrupt(); } catch { /* ignore */ }
      try { await inst?.queueDelete(job.prompt_id); } catch { /* ignore */ }
    }
    store.job.update(jobId, { status: "canceled", finished_at: new Date().toISOString(), error: "用户取消" });
    this.release(jobId);
    // 取消之后这张卡很可能就空下来了：按「安静下来就还显存」的规则再走一遍
    this.scheduleRelease(job.instance, {
      heavy: isHeavyWorkflow(getWorkflow(job.workflow_id)), jobId, reason: "任务取消后释放显存",
    });
    this.emit("job", { job_id: jobId, type: "status", status: "canceled" });
    return store.job.get(jobId);
  }

  // ------------------------------------------------------------- 队列泵
  /**
   * 多卡并行派发：只要还有「空闲槽位」和「待办任务」就继续填。
   * 槽位总量 = 各 ComfyUI 实例 maxConcurrent 之和（4 张卡 = 4 路并行）。
   * 单实例满载时 pickInstance 会跳过它，从而把任务铺到其它卡上。
   */
  async pump() {
    if (this.pumpLock) return;
    this.pumpLock = true;
    try {
      for (;;) {
        const next = store.job.pending().find((j) => !this.inflight.has(j.id));
        if (!next) return;
        const wf = getWorkflow(next.workflow_id) || {};
        const inst = await this.pickInstance(wf);
        if (!inst) return;                        // 无空闲槽位，等下一轮巡检
        this.claim(inst, next);
        this.dispatch(next, inst).catch((err) => {
          log.error(`任务 ${next.id} 派发失败: ${err.message}`);
          this.fail(next.id, { code: err.code || "DISPATCH_FAILED", message: err.message });
        });
      }
    } finally {
      this.pumpLock = false;
    }
  }

  /** 占用一个槽位并置为 dispatching，避免下一轮重复取到同一任务 */
  claim(inst, job) {
    inst.activeJobs += 1;
    this.claimedInst.set(job.id, inst.id);                 // 记住「占的是哪张卡」：release 时不能看 job.instance
    this.markUsed(inst.id);                                // 有活儿了：释放冷却重新开始
    this.inflight.add(job.id);
    store.job.update(job.id, { status: "dispatching", instance: inst.id });
  }

  /** 释放槽位（幂等：仅当任务确实在飞时才扣减，防止重复归还） */
  release(jobId) {
    if (!this.inflight.has(jobId)) return;
    this.inflight.delete(jobId);
    const job = store.job.get(jobId);
    // 认领时的实例才是真正占了槽位的那张卡。不能用 job.instance：
    // OOM / int8-VAE 重试会把 instance 清成 null 再重排，按它归还就会把槽位漏掉；
    // 漏一次 slotsFree 就是 0，故事创作会从「4 卡并行」退化成并发度 1（附录 AL）。
    const instId = this.claimedInst.get(jobId) || job?.instance || null;
    this.claimedInst.delete(jobId);
    const inst = instId ? this.pool.instances.find((i) => i.id === instId) : null;
    if (inst) inst.activeJobs = Math.max(0, inst.activeJobs - 1);
    if (inst && job?.prompt_id) inst.currentPromptIds?.delete(job.prompt_id);
    this.orphanTicks.delete(jobId);
  }

  // ------------------------------------------------- 显存回收（完成 / 取消 / 空闲）
  /**
   * GPU 显存是这台机器最稀缺的资源，用完就该还回去（「完成视频创作后一定要释放占用资源」）。
   *
   * 难的不是「卸」，而是「什么时候卸」：ComfyUI 把权重常驻在显存里，一旦卸载，
   * 下一个任务就要从头加载（MiniMax-H3 这类 40GB+ 的模型是分钟级的），
   * 所以「卸早了」比「卸晚了」代价更大。整体规则：
   *   · 只有这张卡确实空着、且整机也没有别的任务在跑/在排队时才动手（instanceIsIdle）；
   *   · 重型任务（视频/音频）跑完 quietFreeSeconds（默认 20 秒）后检查一次；
   *   · 兜底：任何卡连续空闲超过 idleFreeSeconds（默认 300 秒）都会被回收（sweepIdle）；
   *   · 用户在任务中心手动点「释放显存」不受这些限制（那条路径直接打 /free）。
   */

  /** 把这张卡标记成「刚用过」：释放冷却重新开始算（派发任务、真正释放过之后都走它） */
  markUsed(instId, cooldownMs = Number(config.comfy.idleFreeSeconds || 0) * 1000) {
    if (!instId) return;
    this.releaseAfter.set(instId, Date.now() + Math.max(0, cooldownMs));
  }

  /** 整机现在还有活儿要干吗？本机任务（配音 / 拼接）不占显卡，不算忙 */
  systemQuiet() {
    if (store.job.running().some((j) => j.instance)) return false;
    return !store.job.pending().some((j) => !this.inflight.has(j.id));
  }

  /**
   * 这张卡现在「真的没人用」吗？四个条件必须同时成立：
   *   ① 我们自己没往这张卡上派任务（槽位、在飞的 prompt_id、DB 里的 running 记录都算）；
   *   ② 没有「随时会被铺到这张卡上」的待派发任务 —— pump 每 1.5 秒派一次，
   *      这时候卸掉等于刚出图就又要重新加载；
   *   ③ 整机都安静了 —— 一个镜头跑完、同项目的下一个镜头还在别的卡上跑时，
   *      这张卡的模型留着，紧接着很可能还要用；
   *   ④ ComfyUI 自己的原生队列也是空的（可能有别的客户端往里塞了活儿）。
   */
  async instanceIsIdle(inst) {
    if (!inst || !inst.enabled || !inst.online) return false;
    if (inst.activeJobs > 0) return false;
    if (inst.currentPromptIds?.size) return false;
    if (store.job.running().some((j) => j.instance === inst.id)) return false;
    if (store.job.pending().some((j) => !this.inflight.has(j.id))) return false;
    if (!this.systemQuiet()) return false;
    await inst.refreshQueue();
    return inst.queueLen === 0;
  }

  /** 卸掉模型、把显存还给系统；确认空闲才会真的发 /free（返回是否释放成功） */
  async freeInstance(instId, { jobId = null, reason = "空闲自动回收" } = {}) {
    const inst = this.pool.instances.find((i) => i.id === instId);
    if (!inst) return false;
    if (this.freeing.has(instId)) return false;          // 同一张卡同时只发一次
    this.freeing.add(instId);
    try {
      if (!(await this.instanceIsIdle(inst))) return false;
      if (!(await inst.freeMemory())) return false;
      await inst.refreshStats().catch(() => {});         // 让前端的显存读数立刻回落
      this.markUsed(instId);                             // 冷却重开，别反复打 /free
      const label = inst.label || inst.id;
      store.event.log({ jobId, message: `${label} 上的模型已卸载，显存已释放（${reason}）` });
      log.info(`实例 ${instId} 已释放显存（${reason}）`);
      return true;
    } catch (e) {
      log.warn(`实例 ${instId} 释放显存失败: ${e.message}`);
      return false;
    } finally {
      this.freeing.delete(instId);
    }
  }

  /** 把所有冷却到点、确实空闲的卡扫一遍还显存（各触发点都走这里，反复调用是安全的） */
  async freeIdle({ jobId = null, reason = "空闲自动回收" } = {}) {
    if (this.freePass) return 0;          // 同一时刻只允许一轮：否则多个触发点会各卸一次
    this.freePass = true;
    try {
      const now = Date.now();
      let freed = 0;
      for (const inst of this.pool.instances) {
        if (now < (this.releaseAfter.get(inst.id) || 0)) continue;
        if (await this.freeInstance(inst.id, { jobId, reason })) freed += 1;
      }
      return freed;
    } finally {
      this.freePass = false;
    }
  }

  /**
   * 任务收尾后安排一次回收检查。
   * 不 await 进收尾流程：/free 往返可能要十几秒，不能让「任务完成」的状态卡在那儿。
   * 重活儿把冷却压到 quietFreeSeconds（默认 20 秒）——用户马上又点一次生成的话模型还是热的，
   * 否则这一轮结束就把显存还给系统。
   */
  scheduleRelease(instId, { heavy = false, jobId = null, reason = "" } = {}) {
    if (!instId || !heavy) return;                       // 轻活儿不赶这一趟，等巡检的空闲兜底
    const graceMs = Math.max(0, Number(config.comfy.quietFreeSeconds ?? 20)) * 1000;
    // 收尾的这一刻重新起算：重型任务跑完，这张卡最快 graceMs 之后就可以还显存
    this.markUsed(instId, graceMs);
    const t = setTimeout(() => { this.freeIdle({ jobId, reason }).catch(() => {}); }, graceMs + 1000);
    t.unref?.();
  }

  /** 空闲兜底：每 20 秒看一次「是不是可以还显存了」（节流，避免把 /queue 打爆） */
  async sweepIdle() {
    if (!(Number(config.comfy.idleFreeSeconds) > 0)) return;
    const now = Date.now();
    if (now - (this.idleCheckedAt || 0) < 20000) return;
    this.idleCheckedAt = now;
    await this.freeIdle({ reason: "长时间空闲" });
  }

  /**
   * 槽位计数自愈：以 inflight 为准重算每张卡的 activeJobs。
   *
   * activeJobs 是纯手工加减的计数器，任何一条「漏减 / 重复减」的路径都会让它回不了零；
   * 而 slotsFree = maxConcurrent - activeJobs —— 漏成 1 之后这张卡就再也不会被派活，
   * 故事创作的并发度会从 4 掉到 1（用户看到的「一键生成全部镜头不能多卡并行」）。
   * 以 inflight 为准重算（高了压低、低了补回）；只有「需要下调、而实例队列里确实还有东西在跑」
   * 时跳过（例如 vocal.js 为 Demucs 临时占位，那不是普通任务队列里的活儿）。
   */
  reconcileSlots() {
    const expect = new Map();
    for (const jobId of [...this.inflight]) {
      const j = store.job.get(jobId);
      if (!j) { this.inflight.delete(jobId); this.claimedInst.delete(jobId); continue; }
      const instId = this.claimedInst.get(jobId) || j.instance;
      if (instId) expect.set(instId, (expect.get(instId) || 0) + 1);
    }
    for (const inst of this.pool.instances) {
      const want = Math.min(inst.maxConcurrent, expect.get(inst.id) || 0);
      if (inst.activeJobs === want) continue;
      if (inst.activeJobs > want && Number(inst.queueLen) > 0) continue;
      log.warn(`槽位计数自愈 ${inst.id}: ${inst.activeJobs} → ${want}`);
      inst.activeJobs = want;
    }
  }

  async sweep() {
    // 先对一次账：槽位计数一旦和真实在飞的任务对不上，多卡并行就会被永久锁死
    this.reconcileSlots();
    const jobs = store.job.running();
    // 空闲显存回收：内部有 20 秒节流 + 单卡互斥，这里不 await，
    // 免得刷新队列的往返拖慢了同一轮的超时判定
    this.sweepIdle().catch(() => {});
    for (const j of jobs) {
      const wf = getWorkflow(j.workflow_id);
      const limitMs = (wf?.kind === "video" || wf?.kind === "audio")
        ? config.comfy.videoJobTimeoutMs : config.comfy.imageJobTimeoutMs;
      const started = j.started_at ? Date.parse(j.started_at) : Date.now();
      if (Date.now() - started > limitMs) {
        const inst = this.pool.instances.find((i) => i.id === j.instance);
        try { await inst?.interrupt(); } catch { /* ignore */ }
        this.fail(j.id, { code: "TIMEOUT", message: `任务超时（>${Math.round(limitMs / 60000)} 分钟）` });
      } else if (j.prompt_id && j.instance) {
        await this.tryFinalize(j).catch(() => {});
        await this.checkOrphan(j).catch(() => {});
      }
    }
  }

  /**
   * 「任务从 ComfyUI 里凭空消失」的快速判定。
   * 实例被 OOM Killer 杀掉重启后 /history 是空的、队列里也没这个 prompt，
   * 但 DB 里还写着 running —— 不判的话只能白等到超时（默认 60 分钟）才失败。
   * 连续 3 轮巡检（≈5s）都查不到才判死，避免与正常出队/产物落盘抢跑。
   */
  async checkOrphan(job) {
    const inst = this.pool.instances.find((i) => i.id === job.instance);
    if (!inst || !inst.online) return;                 // 实例掉线走另一套逻辑，不在这里判
    if (this.finalizing.has(job.id)) return;           // 正在回收产物（下载、分离人声），别把正常收尾判成丢失
    const age = job.started_at ? Date.now() - Date.parse(job.started_at) : 0;
    if (age < 45000) return;                           // 刚提交的先给足时间
    const alive = await this.promptAlive(inst, job.prompt_id);
    if (alive) { this.orphanTicks.delete(job.id); return; }
    const n = (this.orphanTicks.get(job.id) || 0) + 1;
    this.orphanTicks.set(job.id, n);
    if (n < 3) return;
    this.orphanTicks.delete(job.id);
    log.warn(`任务 ${job.id} 已从 ${inst.id} 的队列里消失（实例可能重启过），直接判失败`);
    this.fail(job.id, {
      code: "PROMPT_LOST",
      message: `任务已从 ${inst.id} 的队列里消失（ComfyUI 进程大概率中途被杀或重启过），请重新提交`,
    });
  }

  /**
   * prompt 是不是还「活着」：在 /queue 里（跑的 / 排队的）算，跑完进了 /history 也算。
   *
   * 只查 /queue 会把「刚跑完、正在回收产物」的任务误判成丢失 —— 出歌这类活儿执行完还要
   * 下载产物、分离人声、对齐歌词，收尾要十几秒；而 prompt 一执行完就离开 /queue 了，
   * 正好躲不过连续三拍巡检（实测出歌任务连续三次被误判，见需求报告 附录 AC）。
   * 实例真被 OOM Killer 重启时 /history 是空的，照样判得出来。
   */
  async promptAlive(inst, promptId) {
    if (!promptId) return false;
    if (await inst.hasPrompt(promptId)) return true;
    const hist = await inst.getHistory(promptId).catch(() => null);
    return !!(hist && Object.keys(hist).length);
  }

  // ------------------------------------------------------- 本机任务（不经过 ComfyUI）
  /**
   * 跑一个本机任务：不排 GPU 队列、不占显存，但照样写一条 job 记录，任务中心能追溯。
   *
   * 配音 / 换音轨这类活儿是纯 I/O（复制视频流 + 重编码音轨），本机 ffmpeg 秒级完成；
   * 丢给 222 反而要把整段视频的每一帧解码进内存，长视频必然把机器打爆（见需求报告 附录 H.4）。
   * 状态机与远程任务保持一致（running → succeeded | failed），任务中心与 WS 推送都不用改。
   */
  async runLocal({ workflowId, projectId = null, shotId = null, userId = null, params = {}, title = null, run, onJob = null }) {
    const job = store.job.create({
      workflow_id: workflowId, project_id: projectId, shot_id: shotId, user_id: userId,
      engine: "local", vram_class: "light", params: { ...params, _title: title }, status: "running",
    });
    // 有的调用方（例如「拼接成片」）要立刻拿到 job id 去接下一步，所以给一个同步回调
    if (onJob) onJob(store.job.get(job.id));
    const startedAt = new Date().toISOString();
    store.job.update(job.id, { started_at: startedAt, progress: 1 });
    store.event.log({ jobId: job.id, message: `本机处理 ${workflowId}（不占用 222 的 GPU）` });
    this.emit("job", { job_id: job.id, type: "status", status: "running", local: true });
    try {
      const produced = await run(store.job.get(job.id));
      const assets = (Array.isArray(produced) ? produced : [produced]).filter(Boolean);
      const durationMs = Date.now() - Date.parse(startedAt);
      store.job.update(job.id, {
        status: "succeeded", progress: 100, finished_at: new Date().toISOString(), duration_ms: durationMs,
      });
      if (projectId) store.project.touch(projectId);
      if (shotId) {
        const vid = assets.find((a) => a.kind === "video") || assets.find((a) => a.kind === "image");
        if (vid) store.shot.update(shotId, { status: "done", meta: { asset_id: vid.id } });
      }
      for (const a of assets) this.emit("job", { job_id: job.id, type: "asset", asset: publicAsset(a) });
      this.emit("job", { job_id: job.id, type: "done", status: "succeeded", assets: assets.map((a) => a.id) });
      log.info(`本机任务 ${job.id} 完成，产出 ${assets.length} 个文件，耗时 ${durationMs} ms`);
      return { job: store.job.get(job.id), assets };
    } catch (e) {
      this.fail(job.id, { code: e.code || "LOCAL_FAILED", message: e.message });
      throw e;
    }
  }

  // ------------------------------------------------------------- 派发
  async dispatch(job, instance = null) {
    const wf = getWorkflow(job.workflow_id);
    store.job.update(job.id, { status: "dispatching" });
    this.emit("job", { job_id: job.id, type: "status", status: "dispatching" });

    const inst = instance || await this.pickInstance(wf);
    if (!inst) throw Object.assign(new Error("没有可用的 ComfyUI 实例"), { code: "NO_INSTANCE" });
    if (!instance) this.claim(inst, job);   // 直接调用 dispatch 时自行占位

    const ctx = await this.buildContext(job, wf, inst);
    const workflow = normalizeBuiltWorkflow(wf.build(ctx));
    if (ctx._concatReport) {
      const r = ctx._concatReport;
      const msg = "拼接 " + r.total + " 段视频，目标尺寸 " + r.target.width + "x" + r.target.height + "，其中 " + r.conformed + " 段做了尺寸归一化";
      log.info("任务 " + job.id + " " + msg);
      store.event.log({ jobId: job.id, message: msg });
    }
    if (ctx.staleCharacterRefs?.length) {
      const msg = `角色「${ctx.character?.name || ""}」有 ${ctx.staleCharacterRefs.length} 张参考图已从素材库删除，`
        + "本次只用文字提示词锁定人物长相；建议到「角色卡」重新生成一张形象图。";
      log.warn(`任务 ${job.id} ${msg}`);
      store.event.log({ jobId: job.id, level: "warn", message: msg });
    }
    if (ctx.params._fp16Vae) swapToFp16Vae(workflow);

    const hardTypes = ["NODE_MISSING", "INPUT_UNKNOWN", "MODEL_MISSING", "INPUT_ABSENT"];
    let oi = await inst.getObjectInfo();
    let problems = validateWorkflow(workflow, oi).filter((p) => hardTypes.includes(p.type));
    // 下拉清单（音色 / 权重 / 模型名）在平台侧是有缓存的（config.comfy.objectInfoCacheSeconds，默认 10 分钟）。
    // 于是「刚训练出来的音色、刚拷进目录的权重」会出现：磁盘上明明有、页面也能选，提交却被判「不在可选列表中」。
    // 只在确实是「值不在列表」时强制刷一次 /object_info 再判一次，别给每个任务都加一次请求。
    if (problems.some((p) => p.type === "MODEL_MISSING")) {
      const fresh = await inst.getObjectInfo(true).catch(() => null);
      if (fresh) {
        oi = fresh;
        problems = validateWorkflow(workflow, oi).filter((p) => hardTypes.includes(p.type));
        if (!problems.length) log.info(`任务 ${job.id} 的模型清单已刷新（新权重刚到位）`);
      }
    }
    if (problems.length) {
      const err = new Error(`工作流校验失败：${problems.map((p) => p.message).join("；")}`);
      err.code = problems.some((p) => p.type === "MODEL_MISSING") ? "MODEL_MISSING" : "WORKFLOW_INVALID";
      err.status = 400;
      throw err;
    }

    const res = await inst.queuePrompt(workflow, { extra_pnginfo: { avs_job: job.id } });
    const promptId = res?.prompt_id;
    if (!promptId) throw Object.assign(new Error(`ComfyUI 未返回 prompt_id：${JSON.stringify(res).slice(0, 300)}`), { code: "QUEUE_FAILED" });

    inst.currentPromptIds?.add(promptId);
    store.job.update(job.id, {
      status: "running", prompt_id: promptId, instance: inst.id, cuda_index: inst.cuda,
      workflow_json: workflow, started_at: new Date().toISOString(),
      progress: 1, error: null,
    });
    this.emit("job", { job_id: job.id, type: "status", status: "running", instance: inst.id, prompt_id: promptId });
    log.info(`任务 ${job.id} 已在 ${inst.id} 运行 (prompt=${promptId})`);
  }

  async pickInstance(wf) {
    await this.pool.anyOnline();
    const list = this.pool.online();
    if (!list.length) return null;
    // onlyFree=true：满载实例直接跳过 —— 这是多卡负载均衡的关键
    // allowInstances：工作流点名的实例（AI 翻唱 = 本机 192.168.0.128 那台 ComfyUI）
    return this.pool.pickInstance({
      vramNeedBytes: (wf?.vramNeedMB || 0) * 1024 * 1024, onlyFree: true,
      allowInstances: wf?.instances || null,
    });
  }

  // ------------------------------------------------------------- 上下文构建
  async buildContext(job, wf, inst) {
    const params = { ...(job.params || {}) };
    const project = job.project_id ? store.project.get(job.project_id) : null;
    const aspect = params.aspect || project?.aspect || "9:16";
    const a = config.limits.aspects[aspect] || config.limits.aspects["9:16"];
    const step = wf.sizeStep || 16;
    let width = alignUp(params.width || a.genWidth, step);
    let height = alignUp(params.height || a.genHeight, step);
    const maxPixels = Number(params.max_pixels || 0);
    if (maxPixels > 0 && width * height > maxPixels) {
      const k = Math.sqrt(maxPixels / (width * height));
      width = alignUp(width * k, step);
      height = alignUp(height * k, step);
    }

    const style = params.style_id ? store.style.get(params.style_id) : null;
    const characterIds = params.character_ids || (params.character_id ? [params.character_id] : []);
    const characters = characterIds.map((id) => store.character.get(id)).filter(Boolean);
    const character = characters[0] || null;

    const isText = wf.kind === "text";
    const userPrompt = isText ? (params.user_input || params.prompt || "") : (params.prompt || "");
    const prompt = isText
      ? userPrompt
      : compose({
        userPrompt, style, character,
        camera: params.camera?.pose || params.camera_move,
        shotType: params.shot_type,
        engine: wf.engine,
        extra: params.prompt_suffix,
      });
    const negativePrompt = composeNegative({ negative: params.negative_prompt, style, character });

    const refs = params.refs || {};
    const upload = async (assetId) => this.uploadAsset(inst, assetId);
    // 前端每个槽位既可能是单个素材 id，也可能是素材 id 数组（多参考图 / 多段拼接）
    const asIds = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : []);
    const first = (v) => asIds(v)[0] || null;

    const images = {};
    const imageList = [];
    const putImage = async (slot, assetId) => {
      if (!assetId) return;
      const name = await upload(assetId);
      images[slot] = name;
      imageList.push(name);
    };
    await putImage("start_image", first(refs.start_image || params.start_image));
    await putImage("end_image", first(refs.end_image || params.end_image));
    await putImage("mask", first(refs.mask || params.mask_image));
    for (const id of asIds(refs.reference_image ?? refs.ref_images)) await putImage("reference", id);
    for (const id of asIds(refs.character)) await putImage("character", id);
    for (const id of asIds(refs.character_refs)) await putImage("character", id);
    for (const id of asIds(refs.images)) await putImage("ref", id);

    const videos = {};
    const videoList = [];
    // videoMeta 与 videoList 同序：拼接时靠它判断每段真实尺寸，找出异形片段做归一化
    const videoMeta = [];
    const putVideo = async (slot, assetId) => {
      if (!assetId) return;
      const name = await upload(assetId);
      videos[slot] = name;
      videoList.push(name);
      const a = store.asset.get(assetId);
      // 尺寸/帧率/帧数/音轨都要现读现解析：这批素材的 width/height 历史上是空的，
      // 而拼接既要知道谁「异形」，也要靠帧数把帧率换算成目标帧数。
      const info = a?.path ? await readVideoMeta(a.path) : null;
      if (info && a) {
        try { store.asset.setTech(a.id, info); } catch { /* ignore */ }
      }
      videoMeta.push({
        assetId: assetId, file: name,
        width: info?.width ?? a?.width ?? null,
        height: info?.height ?? a?.height ?? null,
        frames: info?.frames ?? null,
        durationMs: info?.durationMs ?? a?.duration_ms ?? null,
        fps: info?.fps ?? a?.fps ?? null,
        hasAudio: info ? !!info.hasAudio : (a ? !!a.has_audio : null),
      });
    };
    await putVideo("control_video", first(refs.control_video));
    await putVideo("pose_video", first(refs.pose_video));
    await putVideo("source_video", first(refs.source_video));
    for (const id of asIds(refs.videos)) await putVideo("seq", id);

    const audios = {};
    const audioList = [];
    const putAudio = async (slot, assetId) => {
      if (!assetId) return;
      const name = await upload(assetId);
      audios[slot] = name;
      audioList.push(name);
    };
    for (const id of asIds(refs.audio)) { await putAudio("audio", id); await putAudio("speech", id); await putAudio("voice", id); }
    for (const id of asIds(refs.speech)) { await putAudio("speech", id); await putAudio("audio", id); }
    for (const id of asIds(refs.bgm)) await putAudio("bgm", id);
    // refs.voice：翻唱的「参考音色」。要放在 refs.audio 之后 ——
    // refs.audio 会顺手把同一段音频塞进 voice 槽位，这里再覆盖成用户真正指定的参考音色。
    for (const id of asIds(refs.voice)) await putAudio("voice", id);


    // 角色参考图作为兜底素材（报告 §8.16 L2 图像锁）
    //
    // 角色卡里的参考图可能已经被从素材库删掉（用户清过素材库 / 换过形象图），角色卡里却还留着旧 id。
    // 「角色还在、图没了」不能让整条任务失败 —— 角色的文字锁（prompt_lock）照样会把年龄 / 气质 /
    // 长相写进提示词，出图仍然可用，只是少了视觉锚点、长得可能没那么稳。
    // 所以这里跳过失效的图、继续往下跑，把失效 id 记进 staleCharacterRefs，交给上层提示用户去补图。
    //
    // 注意要**遍历整个参考图池**、而不是只看前 N 张：新生成的形象图是追加在池尾的，
    // 只取前 N 张会在「旧的都失效了、新的排在最后」时一张都用不上。
    const staleCharacterRefs = [];
    if (!imageList.length && character?.ref_images?.length) {
      const maxRefs = Math.max(1, Number(params.max_ref_images || 3));
      for (const id of character.ref_images) {
        if (imageList.length >= maxRefs) break;
        if (!store.asset.get(id)) { staleCharacterRefs.push(id); continue; }
        await putImage("character", id);
      }
    }

    return {
      workflowId: wf.id,
      params, prompt, negativePrompt, style, character, characters,
      width, height, batchSize: params.batch_size || 1,
      prefix: `avs/${job.project_id || "noproj"}/${job.id}`,
      images, imageList, videos, videoList, videoMeta, audios, audioList,
      aspectGenSize: { width: width, height: height },
      refImages: imageList,
      staleCharacterRefs,
      maskImage: images.mask || null,
      camera: params.camera || null,
      fallbackUpscale: true,
      aspect,
    };
  }

  /** 把本地素材上传到 ComfyUI input 目录（按 asset id 去重） */
  async uploadAsset(inst, assetId) {
    const key = `${inst.id}:${assetId}`;
    if (this.uploads.has(key)) return this.uploads.get(key);
    const a = store.asset.get(assetId);
    if (!a) {
      // 这条素材多半已经被从素材库删掉了（老任务、角色卡里都可能留着旧 id）。
      // 直接把一串内部 id 甩给用户没用，要说清「是什么没了、该怎么办」。
      throw Object.assign(new Error(
        `参考素材已不在素材库里（${assetId}）。它可能被删除过 —— 请重新选择参考图，`
        + "或到「角色卡」给这个角色重新生成 / 上传一张形象图。"),
        { code: "ASSET_NOT_FOUND", status: 400 });
    }
    const buf = await fsp.readFile(a.path);
    const filename = path.basename(a.path);
    const r = await inst.uploadFile(buf, filename);
    this.uploads.set(key, r.ref);
    return r.ref;
  }

  // ------------------------------------------------------------- WS 事件
  onWsEvent({ instanceId, msg }) {
    if (!msg || !msg.type) return;
    const pid = msg.data?.prompt_id;
    // 多卡并行：带 prompt_id 的消息按 id 归属；不带 id 的按实例归属
    const job = pid
      ? store.job.byPromptId(pid)
      : (store.job.running().find((j) => j.instance === instanceId) || null);
    if (!job) return;
    const push = (payload) => this.emit("job", { job_id: job.id, ...payload });

    switch (msg.type) {
      case "execution_start":
        store.job.update(job.id, { status: "running", started_at: new Date().toISOString() });
        push({ type: "status", status: "running", instance: instanceId });
        break;
      case "executing": {
        const node = msg.data?.node;
        if (node === null) { this.tryFinalize(job).catch(() => {}); break; }
        store.job.update(job.id, { progress: Math.max(Number(job.progress || 0), 5) });
        push({ type: "log", message: `执行节点 ${node}` });
        break;
      }
      case "progress": {
        const { value = 0, max = 100, node } = msg.data || {};
        const pct = max > 0 ? Math.round((value / max) * 100) : 0;
        store.job.update(job.id, { progress: pct });
        push({ type: "progress", value, max, percent: pct, node });
        break;
      }
      case "executed":
        push({ type: "log", message: `节点 ${msg.data?.node} 完成` });
        break;
      case "execution_cached":
        push({ type: "log", message: `命中缓存节点 ${(msg.data?.nodes || []).length} 个` });
        break;
      case "execution_error":
        this.onExecutionError(job, msg.data || {}).catch(() => {});
        break;
      default:
        if (msg.type === "status" && msg.data?.status?.exec_info) {
          const q = msg.data.status.exec_info.queue_remaining;
          push({ type: "log", message: `队列剩余 ${q}` });
        }
    }
  }

  onPreviewBinary(ev) {
    const buf = ev?.buffer;
    if (!buf) return;
    // 多卡并行时预览必须归属到「跑在该实例上的那个任务」
    const owner = store.job.running().find((j) => j.instance === ev?.instanceId);
    if (!owner) return;
    const b = Buffer.from(buf);
    // ComfyUI 二进制预览头：前 4 字节为事件类型（1=PNG,2=JPEG）
    const isPng = b.length > 8 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const isJpg = b.length > 4 && b[0] === 0xff && b[1] === 0xd8;
    let data = b;
    if (!isPng && !isJpg && b.length > 8) data = b.subarray(8);
    const mime = (data[1] === 0x50 && data[2] === 0x4e) ? "image/png" : "image/jpeg";
    this.emit("job", {
      job_id: owner.id, type: "preview",
      image_b64: `data:${mime};base64,${data.toString("base64")}`,
    });
  }

  async onExecutionError(job, data) {
    const text = String(data.exception_message || data.exception_type || "执行失败");
    const isOom = /out of memory|OOM/i.test(text);
    // 部分加速 LoRA / int8 kernel 用更新的 CUDA 工具链编译，老驱动会直接 kernel launch failed
    const isKernel = /kernel launch failed|CUDA driver version is insufficient|no kernel image is available/i.test(text);
    log.warn(`任务 ${job.id} 执行错误: ${text}`);
    if (isOom && !job.params?._oomRetried) {
      const inst = this.pool.instances.find((i) => i.id === job.instance);
      try { await inst?.freeMemory(); } catch { /* ignore */ }
      store.job.update(job.id, {
        params: { ...job.params, _oomRetried: true, max_pixels: Math.round((job.params.max_pixels || 1280 * 1024) * 0.55) },
      });
      // 先归还槽位、再清空 instance 重排：顺序反了 release 就找不到该扣哪张卡（槽位泄漏）
      this.release(job.id);
      store.job.update(job.id, { status: "queued", prompt_id: null, progress: 0, instance: null, started_at: null });
      this.emit("job", { job_id: job.id, type: "log", message: "显存不足：已释放显存并降分辨率重试" });
      return;
    }
    if (isKernel && !job.params?._turboRetried) {
      const wfj = store.job.get(job.id)?.workflow_json || {};
      if (usesInt8Vae(wfj)) {
        const inst = this.pool.instances.find((i) => i.id === job.instance);
        try { await inst?.freeMemory(); } catch { /* ignore */ }
        this.release(job.id);
        store.job.update(job.id, {
          params: { ...job.params, _turboRetried: true, _fp16Vae: true },
          status: "queued", prompt_id: null, progress: 0, instance: null, started_at: null,
        });
        this.emit("job", { job_id: job.id, type: "log", message: "int8 VAE 在当前显卡驱动上跑不了，已自动换 fp16 VAE 重跑" });
        return;
      }
    }
    // int8/convrot 权重会走 comfy_kitchen 的自定义 CUDA kernel，驱动过旧时只会报一句
    // "CUDA driver version is insufficient"，这里补上可执行的处置建议。
    const message = isKernel
      ? `${text}（该权重走 comfy_kitchen 的 int8 自定义 kernel，需要更新的 NVIDIA 驱动 ≥560；升级驱动后即可用）`
      : text;
    this.fail(job.id, { code: isOom ? "OOM" : "EXECUTION_ERROR", message, node_type: data.node_type || null, node: data.node_id || null });
  }

  fail(jobId, error) {
    const before = store.job.get(jobId);
    // 已经收尾成功（或已判失败/取消）的任务不再改写：收尾那几秒里若被误判，
    // 会把刚落盘的成功状态改回失败，前端就永远停在红色提示上。
    if (before && TERMINAL.has(before.status)) {
      log.warn(`任务 ${jobId} 已是 ${before.status}，忽略这次失败判定：${error.message}`);
      return;
    }
    store.job.update(jobId, { status: "failed", error: error.message, finished_at: new Date().toISOString() });
    this.release(jobId);
    const failedJob = store.job.get(jobId);
    if (isHeavyWorkflow(getWorkflow(failedJob?.workflow_id))) {
      this.scheduleRelease(failedJob?.instance, { heavy: true, jobId, reason: "任务失败后释放显存" });
    }
    store.event.log({ jobId, level: "error", message: error.message, data: error });
    this.emit("job", {
      job_id: jobId, type: "error", code: error.code || "FAILED",
      message: error.message, node_type: error.node_type || null,
    });
    this.emit("job", { job_id: jobId, type: "done", status: "failed" });
  }

  // ------------------------------------------------------------- 完成与产物回收
  async tryFinalize(job) {
    if (!job.prompt_id || !job.instance) return;
    const fresh = store.job.get(job.id);
    if (!fresh || ["succeeded", "failed", "canceled"].includes(fresh.status)) return;
    if (this.finalizing.has(job.id)) return;
    this.finalizing.add(job.id);
    try {
      await this.finalizeJob(job);
    } finally {
      this.finalizing.delete(job.id);
    }
  }

  async finalizeJob(job) {
    const inst = this.pool.instances.find((i) => i.id === job.instance);
    if (!inst) return;
    const hist = await inst.getHistory(job.prompt_id).catch(() => null);
    const entry = hist?.[job.prompt_id];
    if (!entry) return;
    const statusStr = entry.status?.status_str;
    if (statusStr === "error") {
      const msg = entry.status?.messages?.find((m) => m[0] === "execution_error")?.[1];
      await this.onExecutionError(job, msg || {});
      return;
    }
    if (statusStr !== "success") return;

    const files = collectOutputFiles(entry.outputs || {}, job.workflow_json);
    const wf = getWorkflow(job.workflow_id);
    // 「只出模型、不出媒体」的工作流（WF-36 音色训练）：产物直接写进 ComfyUI 的
    // models/TTS/RVC/*.pth，没有可落盘的图片/音频文件。执行成功就该算成功 ——
    // 音色清单是现扫目录的，新模型下一帧就能选（见 src/vocal.js 的 voices()）。
    if (!files.length && wf?.noOutputs) {
      const ms = job.started_at ? Date.now() - Date.parse(job.started_at) : null;
      store.job.update(job.id, {
        status: "succeeded", progress: 100, finished_at: new Date().toISOString(), duration_ms: ms, error: null,
      });
      if (job.project_id) store.project.touch(job.project_id);
      this.emit("job", { job_id: job.id, type: "done", status: "succeeded", assets: [] });
      store.event.log({ jobId: job.id, message: "任务完成（训练类：模型已写入模型目录，不进素材库）" });
      log.info(`任务 ${job.id} 完成（训练类，无媒体产物），耗时 ${ms} ms`);
      this.release(job.id);
      if (isHeavyWorkflow(wf)) this.scheduleRelease(job.instance, { heavy: true, jobId: job.id, reason: "训练任务完成" });
      return;
    }
    if (!files.length) {
      this.fail(job.id, { code: "NO_OUTPUT", message: "ComfyUI 未产出任何文件（输出节点为空）" });
      return;
    }
    const outDir = path.join(config.paths.exports, job.project_id || "noproj");
    await fsp.mkdir(outDir, { recursive: true });
    const assets = [];
    for (const f of files) {
      try {
        const asset = await this.persistFile(inst, job, wf, f, outDir);
        if (asset) assets.push(asset);
      } catch (err) {
        log.warn(`产物落盘失败 ${f.filename}: ${err.message}`);
      }
    }
    if (!assets.length) {
      this.fail(job.id, { code: "DOWNLOAD_FAILED", message: "产物下载失败" });
      return;
    }

    // 出歌 / 重唱：歌词本来就在手上，顺手按成品时长做一份「跟歌同步」的歌词文件
    // （标准 .lrc / .srt / .ass，见 src/lyrics.js），后面烧字幕时歌词、歌曲与画面就是对齐的。
    if (String(job.params?.lyrics || "").trim()) {
      try { await this.syncLyrics(job, assets); }
      catch (e) { log.warn(`同步歌词生成失败 ${job.id}：${String(e.message).split("\n")[0].slice(0, 200)}`); }
    }

    const durationMs = job.started_at ? Date.now() - Date.parse(job.started_at) : null;
    store.job.update(job.id, {
      status: "succeeded", progress: 100, finished_at: new Date().toISOString(), duration_ms: durationMs,
      error: null,          // 自己收尾成功就把之前可能留下的误判信息擦掉，别让前端一直挂红
    });
    if (job.project_id) store.project.touch(job.project_id);
    if (job.shot_id) {
      const vid = assets.find((a) => a.kind === "video") || assets.find((a) => a.kind === "image");
      if (vid) store.shot.update(job.shot_id, { status: "done", meta: { asset_id: vid.id } });
    }
    for (const a of assets) {
      this.emit("job", { job_id: job.id, type: "asset", asset: publicAsset(a) });
    }
    this.emit("job", { job_id: job.id, type: "done", status: "succeeded", assets: assets.map((a) => a.id) });
    store.event.log({ jobId: job.id, message: `任务完成，产出 ${assets.length} 个文件` });
    log.info(`任务 ${job.id} 完成，产出 ${assets.length} 个文件，耗时 ${durationMs} ms`);
    this.release(job.id);
    // 「跑完就还显存」：重型任务结束后把这张卡的冷却压到安静阈值，
    // 整机安静下来（没有别的任务在跑、也没有在排队的）就把模型卸掉。
    // 队列里还有下一段的话 instanceIsIdle() 会把它拦下来 —— 模型继续热着，不用重复加载。
    if (isHeavyWorkflow(wf)) {
      this.scheduleRelease(job.instance, { heavy: true, jobId: job.id, reason: "视频任务完成" });
    }
  }

  /**
   * 有没有「还没派发、但一定会落到本机这张卡」的任务？有的话就别插队做分离。
   * 通用工作流永远不会被派到本机（pickInstance 会按 local 标记挡掉），所以只看点名了这台的任务。
   */
  anyLocalWorkPending(instId) {
    return store.job.pending().filter((j) => !this.inflight.has(j.id)).some((j) => {
      const wf = getWorkflow(j.workflow_id);
      return Array.isArray(wf?.instances) && wf.instances.includes(instId);
    });
  }

  /**
   * 出歌之后顺手生成「与歌曲同步」的歌词文件。
   *
   * 音乐模型不返回逐句时间码，而歌词是我们自己（手写 / AI 写词）给的纯文本，
   * 所以这里复用配音页那套对齐引擎（src/lyrics.js）。
   *
   * 关键一步：歌曲全程带伴奏，直接在混音上找「人声停顿」会被鼓点与铺底骗过去
   * （实测一首 180 秒的歌只切出 2 段，等于没切开，整份歌词跟着前奏一起跑偏）。
   * 所以先用本机 Demucs 分离出**纯人声**当标尺，再找人声活动区间；
   * 分离约十几秒、结果按文件指纹缓存，重刷歌词不再重复跑；拿不到就退回混音探测。
   *
   * 产物是 .lrc / .srt / .ass 三份标准格式，地址挂到音频素材的 meta.subtitle 上，
   * 前端直接给下载入口，也方便后面烧成硬字幕。纯音乐（没填歌词）直接跳过，不影响出歌本身。
   */
  async syncLyrics(job, assets) {
    const text = String(job.params?.lyrics || "").trim();
    if (!text) return null;
    const song = assets.find((a) => a.kind === "audio") || assets.find((a) => a.kind === "video");
    if (!song) return null;
    const lyrics = require("./lyrics");        // 延迟 require：避免与 workflows 的加载顺序相互纠缠

    let stem = null;
    try {
      const vocal = require("./vocal");
      const inst = this.pool.instances.find((i) => i.id === vocal.LOCAL_INSTANCE) || null;
      if (inst && !this.anyLocalWorkPending(inst.id)) {
        if (inst.online) {
          store.event.log({ jobId: job.id, message: "正在分离人声，用来把歌词和歌声对齐（十几秒）" });
        }
        stem = await vocal.vocalStemFor({ song, inst });
      }
    } catch (e) {
      log.warn(`人声分离失败，改用混音探测：${String(e.message).split("\n")[0].slice(0, 200)}`);
    }

    const r = await lyrics.build({
      media: song,
      lyrics: text,
      mode: "auto",
      vocalStem: stem?.path || null,           // 分离出来的纯人声：对齐标尺
      projectId: job.project_id || null,
      title: job.params?._title || "",         // 提交时的任务名存在 params._title 里（见 jobs.submit）
    });
    const info = {
      count: r.count, mode: r.modeUsed, mode_label: r.modeLabel,
      aligned_by: r.alignedBy, confidence: r.confidence,
      speech_segments: r.speech.count, speech_note: r.speech.note,
      duration_ms: r.durationMs, files: r.files, from: "music-auto",
      lrc_url: r.files?.lrc?.url || null, srt_url: r.files?.srt?.url || null, ass_url: r.files?.ass?.url || null,
    };
    store.asset.updateMeta(song.id, { subtitle: info });
    store.event.log({ jobId: job.id, message: `已生成与歌曲同步的歌词：${r.count} 行（${r.modeLabel}），可下载 .lrc / .srt / .ass` });
    log.info(`同步歌词：${song.id} ${r.count} 行（${r.modeLabel} / ${r.alignedBy}）`);

    return info;
  }

  async persistFile(inst, job, wf, file, outDir) {

    const ext = (file.filename.split(".").pop() || "").toLowerCase();
    const kind = kindOf(ext);
    // 产物名跟着项目走：<项目名称>_<图片|音频|视频|文本>_<流水号>.<ext>（见 src/naming.js）
    const dest = await naming.nextAssetPath(outDir, { projectId: job.project_id, kind, ext });
    const { buffer: buf } = await inst.viewFile({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
    await fsp.writeFile(dest, buf);
    if (kind === "text" && wf?.id === "WF-24") {
      try { job._llmText = buf.toString("utf8"); } catch { /* ignore */ }
    }
    const rel = path.relative(config.paths.data, dest).split(path.sep).join("/");
    const dim = kind === "image" ? probeImageSize(buf, ext)
      : kind === "video" ? (probeVideoMeta(buf) || await readVideoMeta(dest)) : null;
    return store.asset.create({
      job_id: job.id, project_id: job.project_id, shot_id: job.shot_id,
      kind, path: dest, url: `/files/${rel}`, mime: MIME[ext] || "application/octet-stream",
      width: dim?.width ?? null,
      height: dim?.height ?? null,
      duration_ms: wf?.fps ? Math.round(((job.params?.duration_s || 0) * 1000)) : null,
      fps: wf?.fps || null,
      has_audio: !!wf?.hasAudio,
      watermark: false,
      size_bytes: buf.length,
      meta: { source: { filename: file.filename, subfolder: file.subfolder, type: file.type }, engine: wf?.engine, workflow_id: wf?.id },
    });
  }

  /** 等待任务结束（供 /api/prompt/enhance 与 /api/script/generate 同步返回） */
  waitFor(jobId, timeoutMs = 180000) {
    const cur = store.job.get(jobId);
    if (cur && TERMINAL.has(cur.status)) return Promise.resolve(cur);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.off("job", h); resolve(store.job.get(jobId)); }, timeoutMs);
      const h = (ev) => {
        if (ev.job_id !== jobId) return;
        // 终态有两种事件：正常收尾是 type=done，用户在任务中心点「取消」走的是 type=status。
        // 只认 done 的话，取消之后等待方会一直挂到超时——分镜表就卡在「生成中」十几分钟。
        const terminal = ev.type === "done" || (ev.type === "status" && TERMINAL.has(ev.status));
        if (!terminal) return;
        clearTimeout(t); this.off("job", h);
        setTimeout(() => resolve(store.job.get(jobId)), 60);
      };
      this.on("job", h);
    });
  }

  /** 读取文本类任务的 LLM 输出（供 API-07/08 直接返回 JSON） */
  async readJobText(jobId) {
    const assets = store.asset.byJob(jobId).filter((a) => a.kind === "text");
    if (!assets.length) return null;
    const buf = await fsp.readFile(assets[assets.length - 1].path).catch(() => null);
    return buf ? buf.toString("utf8") : null;
  }
}

// ------------------------------------------------------------------ 工具
/**
 * 从 /history 的 outputs 里挑出真正的产物。
 * 注意：LoadVideo / LoadImage / PreviewXxx 这类节点也会出现在 outputs 里（带各自的文件名），
 * 它们只是预览，不是产物——不做区分的话拼接一次就会把每一段原片再复制一份进素材库。
 */
function collectOutputFiles(outputs, graph) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.filename === "string") {
      const key = (node.subfolder || "") + "/" + node.filename;
      if (!seen.has(key)) { seen.add(key); out.push({ filename: node.filename, subfolder: node.subfolder || "", type: node.type || "output" }); }
      return;
    }
    for (const v of Object.values(node)) walk(v);
  };
  let g = graph;
  if (typeof g === "string") { try { g = JSON.parse(g); } catch { g = null; } }
  const ids = Object.keys(outputs || {});
  const keep = g
    ? ids.filter((id) => {
      const cls = String(g[id]?.class_type || "");
      return !cls.startsWith("Load") && !cls.startsWith("Preview");
    })
    : ids;
  (keep.length ? keep : ids).forEach((id) => walk(outputs[id]));
  return out;
}

/** 从文件头解析图片像素尺寸（PNG / JPEG / WebP），失败返回 null */
function probeImageSize(buf, ext) {
  try {
    if (ext === "png") {
      if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (ext === "jpg" || ext === "jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
    if (ext === "webp" && buf.length >= 30) {
      const fourcc = buf.toString("ascii", 12, 16);
      if (fourcc === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (fourcc === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (fourcc === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch { /* 头部异常则忽略 */ }
  return null;
}

const { probeVideoMeta, readVideoMeta } = require("./mp4");
function publicAsset(a) {
  return {
    id: a.id, kind: a.kind, url: a.url, mime: a.mime, width: a.width, height: a.height,
    duration_ms: a.duration_ms, fps: a.fps, has_audio: !!a.has_audio, size_bytes: a.size_bytes,
    watermark: !!a.watermark, project_id: a.project_id, shot_id: a.shot_id, created_at: a.created_at,
  };
}

module.exports = { JobManager, collectOutputFiles, publicAsset, alignUp, extractJson };
