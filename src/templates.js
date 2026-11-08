"use strict";
/**
 * 官方模板广场（需求报告 §13.3 B：596 个官方模板）。
 * 索引快照来自实机 /data/ComfyUI/venv/.../comfyui_workflow_templates_json/templates/index.zh.json
 * （见 tools/sync_templates.md 的同步说明），由 API-19 提供服务。
 */

const fs = require("node:fs");
const path = require("node:path");
const config = require("./config");
const log = require("./logger").scope("templates");

const DIR = path.join(config.paths.data, "templates");

/** 模板名 → 本机能力映射（关键字命中即认为可本地复现） */
const LOCAL_MATCHERS = [
  { key: "z_image", re: /z_image|z-image/i, engine: "z_image", label: "本机可用（Z-Image）" },
  { key: "qwen_image", re: /qwen_image|qwen-image/i, engine: "qwen_image", label: "本机可用（Qwen-Image）" },
  { key: "netayume", re: /netayume|lumina/i, engine: "netayume", label: "本机可用（NetaYume）" },
  { key: "wan22", re: /wan2_2|wan2\.2|wan_2_2/i, engine: "wan22", label: "本机可用（Wan 2.2）" },
  { key: "wan21", re: /wan2_1|wan2\.1|wan_vace|wanmove|animate|infinitetalk|humo|scail|phantom/i, engine: "wan22", label: "本机可用（Wan 2.1/2.2 生态）" },
  { key: "minimax", re: /minimax/i, engine: "minimax_h3", label: "本机可用（MiniMax-H3）" },
  { key: "ltx", re: /ltx/i, engine: "ltx25", label: "本机可用（LTX-2.5）" },
  { key: "seedvr2", re: /seedvr2/i, engine: "seedvr2", label: "需补齐 SeedVR2 权重" },
  { key: "llm", re: /llm_|text_gen/i, engine: "qwen3_text", label: "本机可用（Qwen3-4B 文本）" },
  { key: "audio", re: /audio_|music/i, engine: "native", label: "音频（多数权重缺失）" },
];

let cache = null;

function load() {
  if (cache) return cache;
  const files = [path.join(DIR, "index.zh.json"), path.join(DIR, "index.json")].filter((f) => fs.existsSync(f));
  if (!files.length) {
    log.warn(`未找到官方模板索引快照（${DIR}），模板广场将为空`);
    cache = { generatedAt: null, categories: [], templates: [] };
    return cache;
  }
  const zh = JSON.parse(fs.readFileSync(files[0], "utf8"));
  const en = files[1] ? JSON.parse(fs.readFileSync(files[1], "utf8")) : zh;
  const enTitles = new Map();
  for (const g of en) for (const t of g.templates || []) enTitles.set(t.name, t.title);

  const templates = [];
  const categories = [];
  for (const group of zh) {
    const cat = { moduleName: group.moduleName, category: group.category, title: group.title, icon: group.icon, count: (group.templates || []).length };
    categories.push(cat);
    for (const t of group.templates || []) {
      const m = LOCAL_MATCHERS.find((x) => x.re.test(t.name));
      templates.push({
        name: t.name,
        title: t.title || enTitles.get(t.name) || t.name,
        title_en: enTitles.get(t.name) || null,
        category: group.category,
        group: group.title,
        type: group.type,
        tags: t.tags || [],
        models: t.models || [],
        description: t.description || "",
        tutorial_url: t.tutorialUrl || null,
        size: t.size ?? null,
        usage: t.usage ?? null,
        date: t.date || null,
        io: t.io || null,
        local_engine: m ? m.engine : null,
        local_note: m ? m.label : "本机暂无可直接对应的权重，需自行补齐模型",
        local_supported: !!m,
      });
    }
  }
  cache = { generatedAt: new Date().toISOString(), categories, templates };
  log.info(`官方模板广场已加载：${templates.length} 个模板`);
  return cache;
}

function list({ q, category, type, supported, limit = 200, offset = 0 } = {}) {
  const all = load().templates;
  let out = all;
  if (category) out = out.filter((t) => t.category === category);
  if (type) out = out.filter((t) => t.type === type);
  if (supported === true) out = out.filter((t) => t.local_supported);
  if (q) {
    const s = String(q).toLowerCase();
    out = out.filter((t) => t.name.toLowerCase().includes(s) || (t.title || "").toLowerCase().includes(s)
      || (t.tags || []).join(" ").toLowerCase().includes(s));
  }
  return { total: out.length, items: out.slice(offset, offset + limit) };
}

function meta() { const d = load(); return { generatedAt: d.generatedAt, total: d.templates.length, categories: d.categories }; }

module.exports = { list, meta, load };
