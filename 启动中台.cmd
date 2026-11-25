@echo off
setlocal
set "PORT=7788"
set "NODE=C:\Program Files\nodejs\node.exe"
set "DIR=%~dp0"
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "PROFILE=%LOCALAPPDATA%\YangZhongtai"

if not exist "%NODE%" (
  echo [x] 找不到 Node.js: %NODE%
  pause
  exit /b 1
)
if not exist "%DIR%orchestra\server.mjs" (
  echo [x] 找不到 orchestra\server.mjs
  pause
  exit /b 1
)

netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if %errorlevel%==0 goto open

echo [i] 启动中台服务 :%PORT%
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%NODE%' -ArgumentList '%DIR%orchestra\server.mjs','--port=%PORT%' -WorkingDirectory '%DIR%' -WindowStyle Hidden"
ping -n 3 127.0.0.1 >nul

:open
echo [i] 打开中台窗口
if not "%YANG_NO_OPEN%"=="1" (
  if exist "%EDGE%" (
    start "" "%EDGE%" --app=http://127.0.0.1:%PORT% --user-data-dir="%PROFILE%" --window-size=1500,950 --no-first-run --no-default-browser-check
  ) else (
    start "" "http://127.0.0.1:%PORT%"
  )
)
exit /b 0