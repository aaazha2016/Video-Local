#!/bin/bash
# 在 192.168.0.222 上把 ComfyUI 扩成「一卡一实例」，供本平台多卡并行调用。
#
# 用法（在 222 上以 root 执行）：
#   bash setup-comfyui-multigpu.sh            # 4 张卡 → 8188/8189/8190/8191
#   bash setup-comfyui-multigpu.sh 3          # 只用前 3 张卡
#
# 说明：
#   * 0 号卡沿用已有的 comfyui.service（端口 8188），本脚本只补 1..N-1 号卡；
#   * 每个实例通过 --cuda-device N 绑定到独立显卡，互不抢显存；
#   * 所有实例共用 /data/ComfyUI 的模型目录（只读），不额外占磁盘。

set -euo pipefail

COUNT="${1:-4}"
COMFY_DIR=/data/ComfyUI
PY="$COMFY_DIR/venv/bin/python"

if [ ! -x "$PY" ]; then
  echo "找不到 $PY，请确认 ComfyUI 安装路径" >&2
  exit 1
fi

GPU_TOTAL=$(nvidia-smi --query-gpu=index --format=csv,noheader | wc -l)
if [ "$COUNT" -gt "$GPU_TOTAL" ]; then
  echo "本机只有 $GPU_TOTAL 张卡，请求 $COUNT 张，按 $GPU_TOTAL 处理" >&2
  COUNT="$GPU_TOTAL"
fi

for i in $(seq 1 $((COUNT - 1))); do
  PORT=$((8188 + i))
  cat > /etc/systemd/system/comfyui-gpu${i}.service <<EOF
[Unit]
Description=ComfyUI (GPU ${i}, port ${PORT})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${COMFY_DIR}
Environment="PYTHONUNBUFFERED=1"
Environment="COMFYUI_ARGS=--listen 0.0.0.0 --port ${PORT} --cuda-device ${i} --preview-method auto"
ExecStart=${PY} -u main.py \$COMFYUI_ARGS
Restart=on-failure
RestartSec=10
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
  echo "已写入 comfyui-gpu${i}.service（端口 ${PORT} / cuda:${i}）"
done

systemctl daemon-reload
for i in $(seq 1 $((COUNT - 1))); do
  systemctl enable --now comfyui-gpu${i}.service
done

echo
echo "等待实例启动…"
sleep 15
for i in $(seq 0 $((COUNT - 1))); do
  PORT=$((8188 + i))
  if curl -sf "http://127.0.0.1:${PORT}/system_stats" >/dev/null 2>&1; then
    echo "  [OK] 端口 ${PORT}（cuda:${i}）就绪"
  else
    echo "  [..] 端口 ${PORT}（cuda:${i}）还没起来，稍后用 systemctl status comfyui-gpu${i} 查看"
  fi
done
echo
echo "完成。请把 ${COUNT} 个地址填进本平台的 config.json -> comfy.instances。"