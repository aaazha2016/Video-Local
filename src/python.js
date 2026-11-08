"use strict";
/**
 * 本机 Python 解析（语音合成 edge-tts 通道 / 本机 ffmpeg 通道共用）。
 *
 * 找的是「装了依赖的那个 Python」，候选顺序：
 *   config.runtime.pythonPath → config.tts.pythonPath（旧配置，继续兼容）
 *   → AVS_PYTHON / AVS_TTS_PYTHON → Codex 运行时目录下的 python → PATH 里的 python3 / python。
 * 每个候选都要通过调用方给的 import 探针才算命中，命中结果由调用方自行缓存。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const proc = require("./proc");
const config = require("./config");

/** 可能的 python 解释器清单（去重、保持优先级） */
function candidates() {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  add(config.runtime?.pythonPath);
  add(config.tts?.pythonPath);
  add(process.env.AVS_PYTHON);
  add(process.env.AVS_TTS_PYTHON);
  for (const root of [
    path.join(os.homedir(), ".cache", "codex-runtimes"),
    path.join(os.homedir(), ".codex", "runtimes"),
  ]) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      add(path.join(root, d, "dependencies", "python", "python.exe"));
      add(path.join(root, d, "dependencies", "python", "bin", "python3"));
    }
  }
  add("python3");
  add("python");
  return out;
}

/**
 * 依次探测候选解释器，返回第一个 stdout 里含 marker 的。
 * script 要把结论打到 stdout；marker 就是「依赖装没装」的判据。
 * 全部失败时返回 { exe: null, tried }，由调用方决定报什么错。
 */
async function find({ marker, script, timeoutMs = 20000 }) {
  const tried = [];
  const label = String(marker).replace(/[:_].*$/, "");
  for (const exe of candidates()) {
    try {
      const r = await proc.run(exe, ["-c", script], { timeoutMs });
      if (String(r.stdout).includes(marker)) return { exe, stdout: String(r.stdout).trim(), tried };
      tried.push(`${exe}（没有 ${label}）`);
    } catch (e) {
      tried.push(`${exe}（${String(e.message).split("\n")[0].slice(0, 70)}）`);
    }
  }
  return { exe: null, tried };
}

module.exports = { candidates, find };