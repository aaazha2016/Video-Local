"use strict";
/**
 * AI 短视频创作平台 —— 服务入口
 * 后端：Express + ws；生成侧：本地 ComfyUI（192.168.0.222:8188）
 */

const http = require("node:http");
const os = require("node:os");
const { WebSocketServer } = require("ws");

const config = require("./src/config");
const log = require("./src/logger").scope("server");
const { ComfyPool } = require("./src/comfy");
const { JobManager } = require("./src/jobs");
const { createApp } = require("./src/server-app");
const { BUILTIN_STYLES } = require("./src/styles");
const { checkCapabilities } = require("./src/workflows.registry");
const store = require("./src/store");

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
  }
  return out;
}

async function main() {
  // 1) 内置风格模板入库
  store.seedStyles(BUILTIN_STYLES);

  // 2) ComfyUI 连接池 + 任务编排器
  const pool = new ComfyPool(config.comfy.instances);
  const jobs = new JobManager(pool);
  jobs.start();

  // 3) HTTP
  const app = createApp({ pool, jobs });
  const server = http.createServer(app);

  // 4) WebSocket（API-20）：前端只连本服务，不直连 8188
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/api/ws") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.jobId = url.searchParams.get("job_id") || null;
      ws.isAlive = true;
      ws.on("pong", () => { ws.isAlive = true; });
      clients.add(ws);
      ws.send(JSON.stringify({ type: "hello", server: "ai-video-studio", job_id: ws.jobId }));
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
    });
  });

  const broadcast = (ev) => {
    const payload = JSON.stringify(ev);
    for (const ws of clients) {
      if (ws.readyState !== 1) continue;
      if (ws.jobId && ev.job_id && ws.jobId !== ev.job_id) continue;
      try { ws.send(payload); } catch { /* ignore */ }
    }
  };
  jobs.on("job", broadcast);
  pool.on("health", (status) => broadcast({ type: "instances", instances: status }));
  setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) { ws.terminate(); clients.delete(ws); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);

  // 5) 启动
  await new Promise((resolve) => server.listen(config.server.port, config.server.host, resolve));
  log.info(`服务已启动 http://${config.server.host}:${config.server.port}`);
  for (const ip of lanAddresses()) log.info(`  局域网访问 http://${ip}:${config.server.port}`);

  // 6) 启动即做一次能力自检（后台执行，不阻塞启动）
  checkCapabilities(pool).then((cap) => {
    const bad = cap.workflows.filter((w) => !w.available);
    log.info(`ComfyUI 能力自检：${cap.workflows.length - bad.length}/${cap.workflows.length} 个能力可用`);
    for (const w of bad) log.warn(`  [不可用] ${w.id} ${w.label} — ${w.reasons[0] || ""}`);
  }).catch((e) => log.warn(`能力自检失败: ${e.message}`));

  log.info(`ComfyUI 实例：${config.comfy.instances.map((i) => `${i.id} (${i.url})`).join(", ") || "未配置"}`);

  const shutdown = async () => {
    log.info("正在关闭…");
    jobs.stop();
    pool.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error(`启动失败: ${e.stack || e.message}`);
  process.exit(1);
});
