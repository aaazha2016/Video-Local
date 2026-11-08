"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config");

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levels[process.env.AVS_LOG_LEVEL || "info"] ?? 20;
const logFile = path.join(config.paths.logs, `${new Date().toISOString().slice(0, 10)}.log`);
let stream = null;
try { stream = fs.createWriteStream(logFile, { flags: "a" }); } catch { /* ignore */ }

function write(level, scope, msg, extra) {
  if (levels[level] < threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${msg}` +
    (extra === undefined ? "" : ` ${typeof extra === "string" ? extra : safeJson(extra)}`);
  if (level === "error") console.error(line); else console.log(line);
  if (stream) stream.write(line + "\n");
}
function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

module.exports = {
  scope(name) {
    return {
      debug: (m, e) => write("debug", name, m, e),
      info: (m, e) => write("info", name, m, e),
      warn: (m, e) => write("warn", name, m, e),
      error: (m, e) => write("error", name, m, e),
    };
  },
};
