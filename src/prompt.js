"use strict";
/**
 * 提示词工程（需求报告 §13.1 分层拼接规则、§13.2 三种扩写模板、§13.3 风格模板）。
 *
 * 最终正向提示词 = 风格前缀 + 主体与动作 + 角色锁定串 + 镜头语言 + 画质后缀
 * 最终负向提示词 = 全局基线负向 + 风格负向 + 角色负向
 */

const BASE_NEGATIVE = "模糊, 低分辨率, 畸变, 多余手指, 肢体错乱, 文字, 水印, logo, 过曝, 欠曝, 压缩伪影, 廉价感";

/** 景别中文 → 英文提示词片段 */
const SHOT_TYPE_EN = {
  远景: "wide shot, establishing shot", 全景: "full shot", 中景: "medium shot",
  近景: "medium close-up", 特写: "close-up", 大特写: "extreme close-up",
  wide: "wide shot", medium: "medium shot", closeup: "close-up", "close-up": "close-up",
};

/** 运镜 → 提示词片段 + Wan Fun Camera 枚举（见 src/workflows.video.js） */
const CAMERA_EN = {
  static: "static camera", still: "static camera",
  push: "camera pushes in slowly, dolly in", zoom_in: "camera zooms in",
  pull: "camera pulls back, dolly out", zoom_out: "camera zooms out",
  pan_left: "camera pans left", pan_right: "camera pans right",
  pan_up: "camera tilts up", pan_down: "camera tilts down",
  orbit: "camera orbits around the subject", track: "tracking shot following the subject",
};

const QUALITY_SUFFIX = {
  z_image: "，高清，细节丰富，光影自然",
  qwen_image: "，超清画质，电影级光影，细节丰富",
  qwen_edit: "，保持主体一致，自然过渡，高清",
  netayume: "，精致立绘，高质量，清晰线条",
  wan22: "，画面稳定，电影质感，自然流畅",
  minimax_h3: "，清晰稳定，电影感，音画同步",
  ltx25: "，cinematic, stable motion, high detail",
  default: "，高清，高质量",
};

function joinParts(parts, sep = "，") {
  return parts.filter((p) => p && String(p).trim()).map((p) => String(p).trim()).join(sep);
}

/**
 * 拼接最终提示词。
 * @param {object} o { userPrompt, style, character, camera, shotType, engine, extra }
 */
function compose(o = {}) {
  const style = o.style || {};
  const character = o.character || {};
  const engine = o.engine || "default";
  const head = [style.prompt_prefix].filter(Boolean).join(" ");
  const body = [o.userPrompt].filter(Boolean).join("，");
  const lock = character.prompt_lock ? `【角色】${character.prompt_lock}` : "";
  const cam = [
    SHOT_TYPE_EN[o.shotType] || o.shotType || "",
    CAMERA_EN[o.camera] || o.camera || "",
    o.lighting || "",
  ].filter(Boolean).join(", ");
  const tail = [style.prompt_suffix, QUALITY_SUFFIX[engine] || QUALITY_SUFFIX.default, o.extra]
    .filter(Boolean).join("");
  const sep = engine === "ltx25" ? ", " : "，";
  const parts = engine === "ltx25"
    ? [style.prompt_prefix, body, character.prompt_lock, cam, (style.prompt_suffix || "") + " " + (QUALITY_SUFFIX[engine] || "")]
    : [head, body, lock, cam, tail];
  return joinParts(parts, sep).replace(/\s*,\s*,+/g, ", ").replace(/\s+/g, " ").trim();
}

/** 拼接最终负向提示词 */
function composeNegative(o = {}) {
  const style = o.style || {};
  const character = o.character || {};
  return [BASE_NEGATIVE, o.negative, style.negative, character.negative]
    .filter(Boolean).join(", ");
}

/**
 * 从 LLM 输出里稳健地抽出 JSON（模型可能包 ```json 或加解释文字）。
 */
/**
 * 键名规范化：LLM 经常输出 `" shot_type"`、`"audio Hint"`、`shotType` 这类脏键名，
 * 统一成「去空白 + 空格/连字符→下划线 + 小写」再交给下游读取。
 */
function canonKey(k) {
  return String(k).trim().replace(/[\s\-]+/g, "_").replace(/_+/g, "_").toLowerCase();
}

/** 递归规范化对象键名（数组逐项处理） */
function canonize(value) {
  if (Array.isArray(value)) return value.map(canonize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[canonKey(k)] = canonize(v);
    return out;
  }
  return value;
}

/**
 * 本地小模型（Qwen3-4B 这类）写 JSON 时常犯两种笔误，先修一遍再解析：
 *   1. 收尾括号写成圆括号：`{"at":1500,"name":"转场")`；
 *   2. 被 max_length 截断，结尾少几个 } / ]（字符串也断在半句）。
 * JSON 里 () 只可能出现在字符串内部，字符串外的 ) 一定是笔误，按「最内层还没闭合的括号」补成 } 或 ]。
 */
function repairJson(text) {
  let out = "";
  let inStr = false;
  let esc = false;
  const stack = [];
  for (const ch of String(text)) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === "{" || ch === "[") { stack.push(ch); out += ch; continue; }
    if (ch === "}" || ch === "]") {
      const top = stack[stack.length - 1];
      if (top === (ch === "}" ? "{" : "[")) { stack.pop(); out += ch; }
      else if (top) { stack.pop(); out += top === "{" ? "}" : "]"; }   // 括号打反了，按最内层补
      else out += ch;
      continue;
    }
    if (ch === ")") { const top = stack.pop(); out += top === "[" ? "]" : "}"; continue; }
    out += ch;
  }
  if (inStr) out += '"';                     // 截断在半句字符串，闭合掉
  while (stack.length) out += stack.pop() === "{" ? "}" : "]";
  return out;
}

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const tryParse = (t) => {
    try { return JSON.parse(t); } catch { /* 再试着修常见格式问题 */ }
    try { return JSON.parse(t.replace(/,\s*([}\]])/g, "$1")); } catch { return null; }
  };
  let v = tryParse(s);
  if (v) return canonize(v);
  const first = s.search(/[[{]/);
  if (first >= 0) {
    const lastBrace = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    const cut = lastBrace > first ? s.slice(first, lastBrace + 1) : s.slice(first);
    v = tryParse(cut);
    if (v) return canonize(v);
    v = tryParse(repairJson(cut));
    if (v) return canonize(v);
  }
  v = tryParse(repairJson(s));
  if (v) return canonize(v);
  return null;
}

/**
 * 把分镜 JSON 规范化成内部 shot 结构（§5.2 C）。
 *
 * opts.duration_s：调用方指定了「单镜时长」时，**每个镜头都强制用这个值**，不再听模型自己写的秒数。
 * 「爆款复刻」的单镜时长就是走这个入参 —— 一条片子每镜等长，拼接后的节奏才稳。
 */
function normalizeShots(parsed, opts = {}) {
  if (!parsed) return [];
  const arr = Array.isArray(parsed) ? parsed : (parsed.shots || parsed.shot_list || parsed.storyboard);
  if (!Array.isArray(arr)) return [];
  const forced = Number(opts.duration_s);
  const forceDuration = Number.isFinite(forced) && forced > 0 ? Math.min(20, forced) : null;
  return arr.map((raw, i) => {
    const s = canonize(raw);
    const duration = forceDuration ?? Number(s.duration_s ?? s.duration ?? 5);
    return {
      idx: Number(s.idx ?? s.index ?? s.no ?? i + 1),
      duration_s: Number.isFinite(duration) && duration > 0 ? Math.min(20, duration) : 5,
      shot_type: s.shot_type || s.shottype || "中景",
      camera_move: String(s.camera_move || s.cameramove || "static").trim(),
      prompt: String(s.prompt || s.description || s.desc || s.image_prompt || "").slice(0, 1200).trim(),
      dialogue: s.dialogue || "",
      audio_hint: s.audio_hint || s.audiohint || s.audio || "",
    };
  }).filter((s) => s.prompt);
}

module.exports = {
  BASE_NEGATIVE, SHOT_TYPE_EN, CAMERA_EN, QUALITY_SUFFIX,
  compose, composeNegative, extractJson, normalizeShots, canonize, canonKey,
};
