@echo off
setlocal
set "WATCHDOG=%~dp0core\health\watch-openclaw-gateway.ps1"
set "PWSH=%LocalAppData%\Microsoft\WindowsApps\pwsh.exe"
if not exist "%PWSH%" set "PWSH=pwsh.exe"
"%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%WATCHDOG%"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
