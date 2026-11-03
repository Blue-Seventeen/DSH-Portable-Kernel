@echo off
chcp 65001 >nul 2>nul
setlocal
set "ROOT=%~dp0"
rem same environment as the launchers (TMP/PATH/DSH_*) - otherwise doctor/verify inherit the host
rem environment and the read-only claim cannot be asserted for both entry points
call "%ROOT%env.cmd"
rem entry point for the management script: bypasses the execution policy without changing system settings
rem NOTE: keep this file pure ASCII; Chinese text is printed by tools\say.ps1
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" %*
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :eof
rem 4 = already up to date (shell-update check); not a failure
if "%RC%"=="4" goto :eof
if "%RC%"=="3" (
  echo.
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key cmd-blocked -Value "%RC%"
  if "%~1"=="" pause
  exit /b %RC%
)
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key cmd-failed -Value "%RC%"
if "%~1"=="" pause
exit /b %RC%
