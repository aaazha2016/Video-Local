"use strict";
/**
 * 能力自检脚本：连上本机 ComfyUI，把 24 个工作流全部装配一遍并用实机
 * /object_info 逐字段核对，输出可直接贴给大模型/运维的可用性清单。
 *
 *   node tools/selftest.js            # 只做静态装配校验
 *   node tools/selftest.js --run WF-01A   # 额外真跑一个工作流，验证端到端
 */

const config = require("../src/config");
const { ComfyPool } = require("../src/comfy");
const { checkCapabilities } = require("../src/workflows.registry");
const { JobManager } = require("../src/jobs");

const runId = (() => {
  const i = process.argv.indexOf("--run");
  return i >= 0 ? process.argv[i + 1] : null;
})();

async function main() {
  const pool = new ComfyPool(config.comfy.instances);
  const jobs = new JobManager(pool);
  jobs.start();
  try {
    const cap = await checkCapabilities(pool, { force: true });
    console.log(`ComfyUI 在线：${cap.online}　节点数：${cap.objectInfoNodes}　模板：${cap.templates?.total ?? "-"}`);
    console.log(`实例：${config.comfy.instances.map((i) => `${i.id} → ${i.url}`).join("，")}`);
    console.log("");
    const ok = cap.workflows.filter((w) => w.available);
    const bad = cap.workflows.filter((w) => !w.available);
    for (const w of cap.workflows) {
      const flag = w.available ? "OK  " : "FAIL";
      const extra = w.available
        ? `${w.engine}${w.fps ? ` · ${w.fps}fps` : ""}${w.maxDurationS ? ` · ≤${w.maxDurationS}s` : ""}`
        : `<< ${w.reasons.join(" | ")}`;
      console.log(`${flag} ${w.id.padEnd(7)} ${w.label}　${extra}`);
    }
    console.log(`\n可用 ${ok.length}/${cap.workflows.length}${bad.length ? `，不可用：${bad.map((w) => w.id).join("、")}` : ""}`);

    if (runId) {
      console.log(`\n—— 端到端试跑 ${runId} ——`);
      const t0 = Date.now();
      const job = await jobs.submit({
        workflowId: runId,
        params: config.selftestParams?.[runId] || { prompt: "自检：一只猫坐在窗台上看着夕阳", aspect: "9:16", duration_s: 2 },
      });
      const done = await jobs.waitFor(job.id, 1800000);
      console.log(`结果：${done.status}　耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${done.error ? `　错误：${done.error}` : ""}`);
      const assets = require("../src/store").asset.byJob(job.id);
      for (const a of assets) console.log(`  产物 ${a.kind}　${a.width || "?"}x${a.height || "?"}　${a.url}`);
      process.exitCode = done.status === "succeeded" ? 0 : 1;
    }
  } finally {
    jobs.stop();
    pool.close();
  }
}

main().catch((e) => { console.error(`自检失败：${e.stack || e.message}`); process.exit(1); });
