#!/usr/bin/env bash
# 停止 AI 短视频创作台：优先走 systemd，否则按端口找进程。
set -euo pipefail

PORT="$("node" -e 'console.log(require("./config.json").server.port)' 2>/dev/null || echo 8899)"

if systemctl is-active --quiet ai-video-studio 2>/dev/null; then
  echo "==> 停止 systemd 服务 ai-video-studio"
  systemctl stop ai-video-studio
  exit 0
fi

PIDS="$(ss -lptnH "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)"
if [ -z "$PIDS" ]; then
  echo "==> 端口 $PORT 上没有找到服务进程"
  exit 0
fi
echo "==> 结束进程：$PIDS"
kill $PIDS
