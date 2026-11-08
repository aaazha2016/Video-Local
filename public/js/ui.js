/** 轻量 DOM / 交互工具（无框架） */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(9)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function toast(msg, type = "info", ms = 3800) {
  const root = document.getElementById("toasts");
  const el = h("div", { class: `toast ${type}` }, msg);
  root.append(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 250); }, ms);
}

export function modal(title, contentNode, actions = []) {
  const root = document.getElementById("modal-root");
  const close = () => clear(root);
  const box = h("div", { class: "modal" },
    h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "12px" } },
      h("h3", { style: { margin: 0 } }, title),
      h("button", { class: "ghost sm", onClick: close }, "关闭")),
    contentNode,
    actions.length ? h("div", { class: "row", style: { marginTop: "16px", justifyContent: "flex-end" } }, actions.map((a) =>
      h("button", { class: a.primary ? "primary" : "", onClick: () => a.onClick?.(close) }, a.label))) : null);
  const mask = h("div", { class: "modal-mask", onClick: (e) => { if (e.target === mask) close(); } }, box);
  root.append(mask);
  return close;
}

export const fmtSize = (b) => {
  if (!b && b !== 0) return "-";
  const u = ["B", "KB", "MB", "GB"]; let i = 0; let n = Number(b);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
export const fmtDur = (ms) => {
  if (!ms && ms !== 0) return "-";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s} 秒`;
};
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "-");
export const ago = (iso) => {
  if (!iso) return "-";
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
};
export const STATUS_TEXT = {
  queued: "排队中", dispatching: "准备中", running: "生成中",
  succeeded: "已完成", failed: "失败", canceled: "已取消", pending: "待生成", done: "已完成",
};
export const statusPill = (s) => h("span", {
  class: `pill ${s === "succeeded" || s === "done" ? "ok" : s === "failed" ? "err" : s === "running" ? "acc" : s === "canceled" ? "warn" : ""}`,
}, STATUS_TEXT[s] || s);

export function confirmDialog(title, message, onOk) {
  modal(title, h("p", { class: "muted" }, message), [
    { label: "取消", onClick: (c) => c() },
    { label: "确定", primary: true, onClick: (c) => { c(); onOk(); } },
  ]);
}

export function loadingNode(text = "加载中…") {
  return h("div", { class: "empty" }, h("span", { class: "loading" }), " ", text);
}
export function emptyNode(text, action) {
  return h("div", { class: "empty" }, h("div", null, text), action || null);
}
