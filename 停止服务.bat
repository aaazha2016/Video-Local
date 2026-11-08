@echo off
chcp 65001 >nul
title 停止 AI 短视频创作平台
echo 正在停止 AI 短视频创作平台服务...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo 已停止。
timeout /t 3 >nul