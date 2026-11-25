@echo off
set "PORT=7788"
echo [i] 停止中台 :%PORT%
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  echo     kill PID %%a
  taskkill /f /pid %%a >nul 2>&1
)
echo [i] 完成
ping -n 3 127.0.0.1 >nul