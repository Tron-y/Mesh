@echo off
rem orchestra — 一个页面看全部 agent
rem 用法：双击本文件，或  start.cmd 7788
setlocal
set PORT=%~1
if "%PORT%"=="" set PORT=7788
node "%~dp0server.mjs" --port=%PORT%
