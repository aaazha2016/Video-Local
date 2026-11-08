"use strict";
/**
 * 子进程调用的小封装（本机语音合成、本机 ffmpeg 合成都用它）。
 *
 * 两个要点：
 *   1. 一律带超时并向进程树发 kill，避免把 HTTP 请求或任务挂死；
 *   2. 非 0 退出码时把 stderr 挂在 error 上，调用方才能真正看到原因（ffmpeg 的错误都在 stderr）。
 */

const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * 跑一个进程并收集输出。
 * binary: true 时 stdout 收成 Buffer（音频解码这类二进制输出要用它，字符串拼接会把字节毁掉）。
 * @returns {Promise<{stdout:string|Buffer, stderr:string, code:number}>}
 */
function run(cmd, args, { timeoutMs = DEFAULT_TIMEOUT_MS, input = null, env = {}, cwd = null, timeoutMessage = null, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const opts = { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", ...env } };
      // cwd 是给 ffmpeg 的 subtitles 滤镜用的：Windows 下滤镜参数里的盘符冒号必须转义，
      // 把工作目录切到字幕文件所在目录、只传文件名，就能彻底绕开这层转义地狱。
      if (cwd) opts.cwd = cwd;
      child = spawn(cmd, args, opts);
    } catch (e) { reject(e); return; }

    let out = "";
    const outChunks = [];
    let err = "";
    let done = false;
    const getOut = () => (binary ? Buffer.concat(outChunks) : out);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(Object.assign(
        new Error(timeoutMessage || `${path.basename(cmd)} 执行超时（>${Math.round(timeoutMs / 1000)}s）`),
        { code: "TIMEOUT", stderr: err, stdout: getOut() }));
    }, timeoutMs);

    child.stdout?.on("data", (d) => { if (binary) outChunks.push(d); else out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      reject(Object.assign(new Error(`无法执行 ${cmd}：${e.message}`), { code: "SPAWN_FAILED" }));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code === 0) resolve({ stdout: getOut(), stderr: err, code: 0 });
      else reject(Object.assign(
        new Error(`${path.basename(cmd)} 退出码 ${code}${err.trim() ? `：${err.trim().slice(0, 600)}` : ""}`),
        { code, stderr: err, stdout: getOut() }));

    });

    if (input !== null && input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

module.exports = { run, DEFAULT_TIMEOUT_MS };