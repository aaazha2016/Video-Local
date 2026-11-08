@echo off
chcp 65001 >nul
title 启动全部服务（平台 + ComfyUI）
cd /d "%~dp0"
echo 正在启动 AI 短视频创作平台 + 本机 ComfyUI ...
echo.

rem 1) 平台：Node 服务，后台最小化运行
start "AI短视频创作平台-服务" /min "C:\Program Files\nodejs\node.exe" server.js

rem 2) 本机 ComfyUI：需要 ffmpeg 在 PATH 上 + UTF-8 环境（RVC 训练要用）
set "PATH=E:\ComfyUI-aki-v2\tools\ffmpeg;%PATH%"
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
start "ComfyUI-服务" /min /d "E:\ComfyUI-aki-v2" "E:\ComfyUI-aki-v2\python\python.exe" -s "ComfyUI\main.py" --port 8188 --listen 127.0.0.1 --disable-auto-launch

timeout /t 6 >nul
echo 平台地址：http://127.0.0.1:8899   （局域网：http://192.168.0.128:8899）
echo ComfyUI ：http://127.0.0.1:8188
echo.
echo ComfyUI 首次加载要 30~60 秒，慢一点正常。
echo 两个服务分别在最小化的窗口里跑；注意：关掉那两个窗口，服务就停了。
echo.
pause