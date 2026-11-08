"use strict";
const { EventEmitter } = require("node:events");
const WebSocket = require("ws");
const config = require("./config");
const log = require("./logger").scope("comfy");

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

class ComfyInstance extends EventEmitter {
  constructor(def) {
    super();
    this.id = def.id;
    this.label = def.label || def.id;
    this.url = def.url;
    this.cuda = def.cuda;
    this.maxConcurrent = Math.max(1, def.maxConcurrent || 1);
    this.enabled = def.enabled !== false;
    // 「专用实例」：本机 192.168.0.128 上的 ComfyUI（AI 翻唱用）。
    // 它只装得下自己那套权重（RVC / Demucs / ACE-Step），所以既不参与通用调度，
    // 也不许通用工作流派过来 —— 双向都由 pickInstance 把关。
    this.local = def.local === true;
    this.dedicatedWorkflows = Array.isArray(def.workflows) ? def.workflows : null;
    this.online = false;
    this.stats = null;
    this.objectInfo = null;
    this.objectInfoAt = 0;
    this.queueLen = 0;
    this.activeJobs = 0;
    this.ws = null;
    this.wsReady = false;
    this.clientId = `avs-${this.id.replace(/[^a-z0-9]/gi, "")}-${Math.random().toString(36).slice(2, 8)}`;
    this.reconnectDelay = 1000;
    // 本实例正在跑的 prompt_id（jobs.js 派发时登记，完成/失败后摘掉）
    this.currentPromptIds = new Set();
    this.wsUrl = this.url.replace(/^http/, "ws") + `/ws?clientId=${this.clientId}`;
  }

  get vramFree() {
    const d = this.stats?.devices?.find((x) => x.index === this.cuda) || this.stats?.devices?.[0];
    return d ? d.vram_free : 0;
  }
  get vramTotal() {
    const d = this.stats?.devices?.find((x) => x.index === this.cuda) || this.stats?.devices?.[0];
    return d ? d.vram_total : 0;
  }
  /** 该实例当前空闲的可派发槽位（maxConcurrent - 在跑任务数） */
  get slotsFree() { return Math.max(0, this.maxConcurrent - this.activeJobs); }
  get hasCapacity() { return this.slotsFree > 0; }

  async refreshStats() {
    try {
      const res = await fetchWithTimeout(`${this.url}/system_stats`, {}, 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.stats = await res.json();
      this.online = true;
      return this.stats;
    } catch (err) {
      this.online = false;
      log.warn(`实例 ${this.id} 不可用: ${err.message}`);
      return null;
    }
  }

  async refreshQueue() {
    try {
      const res = await fetchWithTimeout(`${this.url}/queue`, {}, 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const q = await res.json();
      this.queueLen = (q.queue_running?.length || 0) + (q.queue_pending?.length || 0);
      return this.queueLen;
    } catch { return this.queueLen; }
  }

  async getObjectInfo(force = false) {
    const age = (Date.now() - this.objectInfoAt) / 1000;
    if (!force && this.objectInfo && age < config.comfy.objectInfoCacheSeconds) return this.objectInfo;
    const res = await fetchWithTimeout(`${this.url}/object_info`, {}, 60000);
    if (!res.ok) throw new Error(`object_info HTTP ${res.status}`);
    this.objectInfo = await res.json();
    this.objectInfoAt = Date.now();
    log.info(`实例 ${this.id} 节点定义已加载: ${Object.keys(this.objectInfo).length} 个节点`);
    return this.objectInfo;
  }

  async listModels(folder) {
    const res = await fetchWithTimeout(`${this.url}/models/${encodeURIComponent(folder)}`, {}, 15000);
    if (!res.ok) throw new Error(`models/${folder} HTTP ${res.status}`);
    return res.json();
  }

  async uploadFile(buffer, filename, { subfolder = "", type = "input", field = "image" } = {}) {
    const form = new FormData();
    form.append(field, new Blob([buffer]), filename);
    form.append("overwrite", "true");
    form.append("type", type);
    if (subfolder) form.append("subfolder", subfolder);
    const res = await fetchWithTimeout(`${this.url}/upload/image`, {
      method: "POST", body: form,
    }, config.comfy.uploadTimeoutMs);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`上传失败 HTTP ${res.status} ${txt.slice(0, 300)}`);
    }
    const data = await res.json();
    return { name: data.name, subfolder: data.subfolder || "", type: data.type || "input", ref: data.subfolder ? `${data.subfolder}/${data.name}` : data.name };
  }

  async queuePrompt(workflow, extraData = {}) {
    const body = { prompt: workflow, client_id: this.clientId, extra_data: extraData };
    const res = await fetchWithTimeout(`${this.url}/prompt`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, config.comfy.promptTimeoutMs);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* keep raw */ }
    if (!res.ok) {
      const nodeErrs = data?.node_errors
        ? Object.entries(data.node_errors).flatMap(([nid, ne]) => (ne.errors || []).map((e) =>
          `节点${nid}(${ne.class_type || "?"}) ${e.message}${e.details ? `：${e.details}` : ""}`)).slice(0, 4).join("；")
        : "";
      const err = new Error(`提交失败 HTTP ${res.status}${nodeErrs ? `　${nodeErrs}` : data?.error?.message ? `　${data.error.message}` : ""}`);
      err.detail = data || text;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async getHistory(promptId) {
    const res = await fetchWithTimeout(`${this.url}/history/${promptId}`, {}, 20000);
    if (!res.ok) throw new Error(`history HTTP ${res.status}`);
    return res.json();
  }

  /**
   * 这个 prompt 还在 ComfyUI 的队列里吗（跑的或排队的）？
   * 实例被 OOM Killer 杀掉再重启时 /history 会清空，只能靠 /queue 判断
   * 「任务其实早就没了」——否则 DB 里的 running 会一直挂到超时才失败。
   */
  async hasPrompt(promptId) {
    if (!promptId) return false;
    const res = await fetchWithTimeout(`${this.url}/queue`, {}, 8000);
    if (!res.ok) throw new Error(`queue HTTP ${res.status}`);
    const q = await res.json();
    const hit = (arr) => (Array.isArray(arr) ? arr : []).some((e) => e && (e[1] === promptId || e.prompt_id === promptId));
    return hit(q.queue_running) || hit(q.queue_pending);
  }

  async viewFile({ filename, subfolder = "", type = "output" }) {
    const qs = new URLSearchParams({ filename, subfolder: subfolder || "", type: type || "output" });
    const res = await fetchWithTimeout(`${this.url}/view?${qs.toString()}`, {}, 600000);
    if (!res.ok) throw new Error(`view HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, contentType: res.headers.get("content-type") || "application/octet-stream" };
  }

  async interrupt() {
    try { await fetchWithTimeout(`${this.url}/interrupt`, { method: "POST" }, 10000); } catch (e) { log.warn(`interrupt 失败: ${e.message}`); }
  }

  /**
   * 卸载模型 + 释放显存（POST /free）。
   * 返回是否成功 —— 自动回收（jobs.js 的 freeInstance）要据此判断这一次到底有没有生效。
   */
  async freeMemory() {
    try {
      const res = await fetchWithTimeout(`${this.url}/free`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      }, 15000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      log.info(`实例 ${this.id} 已释放显存`);
      return true;
    } catch (e) { log.warn(`free 失败: ${e.message}`); return false; }
  }

  async removeFromQueue(promptId) {
    try {
      await fetchWithTimeout(`${this.url}/queue`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [promptId] }),
      }, 10000);
    } catch (e) { log.warn(`queue delete 失败: ${e.message}`); }
  }

  connectWs() {
    if (!this.enabled) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    try {
      this.ws = new WebSocket(this.wsUrl, { handshakeTimeout: 15000 });
    } catch (err) {
      log.warn(`WS 创建失败: ${err.message}`);
      return this.scheduleReconnect();
    }
    this.ws.on("open", () => {
      this.wsReady = true;
      this.reconnectDelay = 1000;
    // 本实例正在跑的 prompt_id（jobs.js 派发时登记，完成/失败后摘掉）
    this.currentPromptIds = new Set();
      log.info(`实例 ${this.id} WS 已连接`);
      this.emit("ws-open");
    });
    this.ws.on("message", (raw, isBinary) => {
      if (isBinary) { this.emit("preview-binary", raw); return; }
      let msg = null;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      this.emit("event", msg);
    });
    this.ws.on("close", () => { this.wsReady = false; this.scheduleReconnect(); });
    this.ws.on("error", (err) => { log.warn(`实例 ${this.id} WS 错误: ${err.message}`); });
  }

  scheduleReconnect() {
    if (!this.enabled || this.closing) return;
    const delay = Math.min(this.reconnectDelay, 30000);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    setTimeout(() => this.connectWs(), delay);
  }

  close() { this.closing = true; try { this.ws?.close(); } catch { /* ignore */ } }
}

class ComfyPool extends EventEmitter {
  constructor(defs) {
    super();
    this.instances = defs.map((d) => new ComfyInstance(d));
    for (const inst of this.instances) {
      inst.on("event", (msg) => this.emit("event", { instanceId: inst.id, instance: inst, msg }));
      inst.on("preview-binary", (raw) => this.emit("preview-binary", { instanceId: inst.id, instance: inst, buffer: raw }));
      inst.connectWs();
    }
    this.healthTimer = setInterval(() => this.healthTick(), 10000);
    this.healthTick();
  }

  async healthTick() {
    await Promise.all(this.instances.map(async (i) => {
      if (!i.enabled) return;
      await i.refreshStats();
      await i.refreshQueue();
    }));
    this.emit("health", this.status());
  }

  status() {
    return this.instances.map((i) => ({
      id: i.id, label: i.label, url: i.url, cuda: i.cuda, online: i.online, enabled: i.enabled,
      vram_total: i.vramTotal, vram_free: i.vramFree, queue: i.queueLen, active: i.activeJobs,
      max_concurrent: i.maxConcurrent, slots_free: i.slotsFree,
      ws: i.wsReady,
      local: i.local, dedicated_workflows: i.dedicatedWorkflows,
    }));
  }

  online() { return this.instances.filter((i) => i.enabled && i.online); }

  /** 全局槽位统计：多卡并行调度与前端展示都用它 */
  capacity() {
    // 专用实例（本机 5090 的翻唱节点）不算进并行度：它只接点名找它的工作流，
    // 算进来的话「故事创作一次生成 N 个镜头」会以为多出 1 路并行，实际派不过去。
    const list = this.online().filter((i) => !i.local);
    const total = list.reduce((s, i) => s + i.maxConcurrent, 0);
    const used = list.reduce((s, i) => s + Math.min(i.activeJobs, i.maxConcurrent), 0);
    return { instances: list.length, total, used, free: Math.max(0, total - used) };
  }

  /** 当前可用并行度（故事模式等批量任务据此决定并发数） */
  parallelSlots() {
    const list = this.online().filter((i) => !i.local);
    if (!list.length) return 1;
    return Math.max(1, list.reduce((s, i) => s + i.slotsFree, 0));
  }

  async anyOnline() {
    if (this.online().length) return this.online();
    await Promise.all(this.instances.map((i) => i.refreshStats()));
    return this.online();
  }

  pickInstance({ vramNeedBytes = 0, preferId = null, onlyFree = false, allowInstances = null } = {}) {
    let pool = this.online().length ? this.online() : this.instances.filter((i) => i.enabled);
    // 专用实例的双向隔离（例子：AI 翻唱 WF-28/29/30 只在本机 5090 上有权重）：
    //   · 工作流点名了实例（wf.instances）→ 只在点名的实例里挑；
    //   · 没点名的通用工作流 → 永不落到专用实例上（那台的模型清单完全不同）。
    if (allowInstances && allowInstances.length) pool = pool.filter((i) => allowInstances.includes(i.id));
    else pool = pool.filter((i) => !i.local);

    // 并行调度时只挑还有空槽位的实例；满载返回 null，交由队列等下一轮
    if (onlyFree) pool = pool.filter((i) => i.hasCapacity);
    if (!pool.length) return null;
    if (preferId) {
      const exact = pool.find((i) => i.id === preferId);
      if (exact) return exact;
    }
    const need = vramNeedBytes * 1.15;
    const scored = pool.map((i) => {
      const free = i.vramFree || 0;
      const fits = need === 0 ? 1 : free >= need ? 1 : 0;
      return { inst: i, fits, load: i.activeJobs + i.queueLen, free };
    });
    scored.sort((a, b) => (b.fits - a.fits) || (a.load - b.load) || (b.free - a.free));
    return scored[0].inst;
  }

  find(promptId) {
    for (const inst of this.instances) {
      if (inst.currentPromptIds?.has(promptId)) return inst;
    }
    return null;
  }

  async validateWorkflow(workflow, instance) {
    const oi = await instance.getObjectInfo();
    const problems = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
      const def = oi[node.class_type];
      if (!def) { problems.push({ node: nodeId, type: "NODE_MISSING", class_type: node.class_type, message: `节点类型 ${node.class_type} 不存在` }); continue; }
      const spec = { ...(def.input?.required || {}), ...(def.input?.optional || {}) };
      for (const [key, val] of Object.entries(node.inputs || {})) {
        const s = spec[key];
        if (!s) { problems.push({ node: nodeId, class_type: node.class_type, type: "INPUT_UNKNOWN", message: `输入 ${key} 不存在` }); continue; }
        const options = Array.isArray(s[0]) ? s[0] : (Array.isArray(s[1]?.options) ? null : null);
        if (options && typeof val === "string" && !options.includes(val)) {
          problems.push({ node: nodeId, class_type: node.class_type, type: "MODEL_MISSING", message: `${key}="${val}" 不在可用列表中`, key, value: val, optionsSample: options.slice(0, 12) });
        }
      }
      for (const [key, s] of Object.entries(spec)) {
        if (Array.isArray(s) && s[1]?.default === undefined && s[1] !== null && !(key in (node.inputs || {})) && (def.input?.required?.[key])) {
          problems.push({ node: nodeId, class_type: node.class_type, type: "INPUT_REQUIRED", message: `缺少必填输入 ${key}` });
        }
      }
    }
    return problems;
  }

  close() { clearInterval(this.healthTimer); this.instances.forEach((i) => i.close()); }
}

module.exports = { ComfyPool, ComfyInstance, fetchWithTimeout };
