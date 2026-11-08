/** 应用入口：路由 / 侧栏 / 顶栏 / 全局 WebSocket（对应需求报告 §9.1 信息架构） */

import { api, connectWs } from "./api.js";
import { h, clear, toast, $ } from "./ui.js";
import { views, state } from "./views.js";

const NAV = [
  { path: "/", label: "工作台", ico: "🏠" },
  { path: "/create", label: "创作台", ico: "🎬" },
  { path: "/music", label: "AI 音乐", ico: "🎵" },
  { path: "/vocal", label: "AI 翻唱", ico: "🎤" },
  { path: "/trending", label: "爆款复刻", ico: "🔥" },
  { path: "/dub", label: "配音", ico: "🎙️" },
  { path: "/story", label: "故事创作", ico: "📖" },
  { path: "/characters", label: "角色卡", ico: "🎭" },
  { path: "/templates", label: "模板广场", ico: "🧩" },
  { path: "/assets", label: "素材库", ico: "🗂️" },
  { path: "/jobs", label: "任务中心", ico: "⚙️" },
];
const ROUTES = {
  "/": "home", "/create": "create", "/dub": "dub", "/story": "story", "/characters": "characters",
  "/templates": "templates", "/assets": "assets", "/jobs": "jobs", "/trending": "trending",
  "/vocal": "vocal",
  "/music": "music",
};

function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, "")) || "/";
  const [path, qs] = raw.split("?");
  return { path: path || "/", params: Object.fromEntries(new URLSearchParams(qs || "")) };
}

const ctx = {
  go(path) { if (location.hash.replace(/^#/, "") === path) render(); else location.hash = path; },
  reload() { render(); },
  refreshQueueBadge() { refreshQueueBadge(); },
};

// ---------------------------------------------------------------- 侧栏 / 顶栏
function renderNav() {
  const nav = $("#nav");
  clear(nav);
  for (const item of NAV) {
    nav.append(h("a", { href: `#${item.path}`, "data-path": item.path },
      h("span", { class: "ico" }, item.ico), h("span", null, item.label)));
  }
}
function highlightNav(path) {
  for (const a of document.querySelectorAll("#nav a")) {
    a.classList.toggle("active", a.dataset.path === path);
  }
}
const CRUMB = { "/": "工作台", "/create": "创作台", "/vocal": "AI 翻唱", "/music": "AI 音乐", "/trending": "爆款复刻", "/dub": "配音", "/story": "故事创作", "/characters": "角色卡", "/templates": "模板广场", "/assets": "素材库", "/jobs": "任务中心" };

function renderCrumb(path) { $("#crumb").textContent = CRUMB[path] || "工作台"; }

function renderGpu(instances) {
  const el = $("#gpu-card");
  if (!el) return;
  clear(el);
  if (!instances?.length) { el.append(h("div", { class: "tiny muted" }, "未配置 ComfyUI 实例")); return; }
  for (const i of instances) {
    const total = i.vram_total || 0; const free = i.vram_free || 0;
    const used = total ? Math.round(((total - free) / total) * 100) : 0;
    el.append(h("div", { style: { marginBottom: "8px" } },
      h("div", { class: "row", style: { justifyContent: "space-between" } },
        h("b", null, i.id),
        h("span", { class: `pill ${i.online ? "ok" : "err"}` }, i.online ? "在线" : "离线")),
      h("div", { class: "tiny muted" }, total ? `显存 ${(free / 1024 ** 3).toFixed(1)} / ${(total / 1024 ** 3).toFixed(1)} GB` : "正在读取显存…"),
      h("div", { class: "bar", style: { marginTop: "4px" } }, h("i", { style: { width: `${used}%` } })),
      h("div", { class: "tiny muted" }, `队列 ${i.queue ?? 0} · 运行中 ${i.active ?? 0}`)));
  }
}

async function refreshQueueBadge() {
  const badge = $("#queue-badge");
  if (!badge) return;
  try {
    const list = await api.jobs({ limit: 100 });
    state.jobs = list;
    const n = list.filter((j) => ["queued", "dispatching", "running"].includes(j.status)).length;
    badge.textContent = String(n);
    badge.style.display = n ? "" : "none";
  } catch { /* 静默 */ }
}

// ---------------------------------------------------------------- 渲染
function render() {
  clearInterval(state.__jobsTimer);
  const { path, params } = parseHash();
  if (params.project) state.projectId = params.project;
  if (params.mode) state.mode = params.mode;
  highlightNav(path);
  renderCrumb(path);
  const name = ROUTES[path] || "home";
  const el = $("#view");
  clear(el);
  try {
    const node = views[name](ctx);
    el.append(node || h("div"));
  } catch (e) {
    console.error(e);
    el.append(h("div", { class: "card" }, h("h3", null, "页面渲染失败"), h("div", { class: "pill err" }, e.message)));
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- 启动
function bindTopbar() {
  $("#btn-cap").onclick = async () => {
    const btn = $("#btn-cap");
    btn.disabled = true; btn.textContent = "自检中…";
    try {
      state.capabilities = await api.recheck();
      const bad = state.capabilities.workflows.filter((w) => !w.available);
      toast(`能力自检完成：${state.capabilities.workflows.length - bad.length}/${state.capabilities.workflows.length} 项可用`, "ok", 6000);
      render();
    } catch (e) { toast(`自检失败：${e.message}`, "err", 8000); }
    btn.disabled = false; btn.textContent = "能力自检";
  };
  $("#btn-queue").onclick = () => ctx.go("/jobs");
}

async function loadData() {
  const tasks = [
    api.capabilities().then((c) => { state.capabilities = c; }),
    api.projects().then((p) => { state.projects = p; if (!state.projectId && p.length) state.projectId = p[0].id; }),
    api.styles().then((s) => { state.styles = s; }),
    api.instances().then((i) => renderGpu(i)),
    api.assets({ limit: 2000 }).then((list) => {
      state.__assetIndex = Object.fromEntries(list.map((a) => [a.id, a]));
      state.assets = list;
    }),
    api.characters().then((c) => { state.characters = c; }),
  ];
  const results = await Promise.allSettled(tasks);
  const fail = results.find((r) => r.status === "rejected");
  if (fail && !state.capabilities) toast(`初始化失败：${fail.reason?.message || fail.reason}`, "err", 9000);
}

function onGlobalEvent(ev) {
  if (ev.type === "instances") { renderGpu(ev.instances); return; }
  if (ev.type === "status" || ev.type === "done") refreshQueueBadge();
}

async function boot() {
  renderNav();
  bindTopbar();
  window.addEventListener("hashchange", render);
  render();
  await loadData();
  render();
  refreshQueueBadge();
  setInterval(refreshQueueBadge, 6000);
  connectWs(null, onGlobalEvent);
  if (!location.hash) ctx.go("/");
}

boot();
