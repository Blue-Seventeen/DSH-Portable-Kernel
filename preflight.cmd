@echo off
chcp 65001 >nul 2>nul
setlocal
set "ROOT=%~dp0"
call "%ROOT%env.cmd"
rem Everything else (tar / 7z / robocopy / curl) is detected at run time and has a fallback;
rem PowerShell is the only thing that cannot be substituted, so check it first and say so plainly.
if not exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
  echo.
  echo   [X] Windows PowerShell is missing on this machine, so this portable shell cannot run.
  echo       Expected at %%SystemRoot%%\System32\WindowsPowerShell\v1.0\powershell.exe
  echo       Any Windows 7 SP1 or later ships it by default; re-enable the Windows PowerShell feature.
  echo.
  pause
  exit /b 1
)
rem NOTE: keep this file pure ASCII; Chinese text is printed by tools\say.ps1
rem A fresh git clone only has the shell. If any official layer is missing, bootstrap it first
rem (node runtime + pnpm + app + desktop + plugin deps), each step with a progress bar.
if not exist "%ROOT%runtime\node\bin\node.exe" goto dsh_boot
if not exist "%ROOT%runtime\pnpm\dist\pnpm.mjs" goto dsh_boot
if not exist "%ROOT%app\node_modules\@deepseek-ai\dsh\lib\bin.js" goto dsh_boot
if not exist "%ROOT%desktop\resources\app.asar" goto dsh_boot
goto dsh_ready
:dsh_boot
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key bootstrap-start
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" bootstrap
if errorlevel 1 (
  echo.
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key bootstrap-fail
  if "%~1"=="" pause
  exit /b 1
)
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key bootstrap-done
:dsh_ready
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\preflight.mjs"
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key preflight-menu -NoNewline
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key preflight-hint
choice /C WDN /T 30 /D N /N /M " > "
if errorlevel 3 goto :end
if errorlevel 2 goto :desk
if errorlevel 1 goto :web
:web
call "%ROOT%start-web.cmd"
goto :end
:desk
call "%ROOT%start-desktop.cmd"
:end
endlocal