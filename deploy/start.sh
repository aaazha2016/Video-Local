#!/usr/bin/env bash
# 启动 AI 短视频创作台（后端 + 依赖检查）。默认端口 8899，见 config.json。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE_BIN="${NODE_BIN:-node}"
COMFY_URL="$("$NODE_BIN" -e 'console.log(require("./config.json").comfy.instances[0].url)' 2>/dev/null || echo '')"

echo "==> 检查 ComfyUI 实例：${COMFY_URL:-未配置}"
if [ -n "$COMFY_URL" ]; then
  if curl -fsS --max-time 8 "$COMFY_URL/system_stats" >/dev/null; then
    echo "    ComfyUI 在线"
  else
    echo "    警告：无法连接 $COMFY_URL，服务仍会启动，稍后可在页面点「能力自检」重试"
  fi
fi

if [ ! -d node_modules ]; then
  echo "==> 安装依赖"
  "$NODE_BIN" --version
  npm install --omit=dev
fi

echo "==> 启动服务（Ctrl+C 退出）"
exec "$NODE_BIN" server.js
