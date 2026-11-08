@echo off
chcp 65001 >nul
title AI 短视频创作平台
cd /d "%~dp0"
echo 正在启动 AI 短视频创作平台...
start "AI短视频创作平台-服务" /min "C:\Program Files\nodejs\node.exe" server.js
timeout /t 4 >nul
echo 服务地址：http://127.0.0.1:8899
echo.
echo 这个窗口可以关掉，服务在最小化的那个窗口里跑；要停服务请运行「停止服务.bat」。
pause