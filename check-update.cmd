@echo off
chcp 65001 >nul 2>nul
rem NOTE: keep this file pure ASCII; Chinese text is printed by tools\say.ps1
if not defined ROOT set "ROOT=%~dp0"
if not defined DSH_HOME call "%ROOT%env.cmd"
if not exist "%ROOT%logs" mkdir "%ROOT%logs" >nul 2>nul
rem shared pre-launch check: finish an interrupted update, then look for a newer version
if exist "%ROOT%tmp\update-journal.json" (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-interrupted
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" repair
)
if defined DSH_PORTABLE_NO_UPDATE_CHECK goto :eof
if not exist "%ROOT%tmp" mkdir "%ROOT%tmp" >nul 2>nul
set "MSGFILE=%ROOT%tmp\update-check.txt"
if exist "%MSGFILE%" del "%MSGFILE%" >nul 2>nul
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\update-check.mjs" > "%MSGFILE%" 2> "%ROOT%logs\update-check.err"
if not exist "%MSGFILE%" goto :eof
for %%F in ("%MSGFILE%") do if %%~zF EQU 0 goto :eof
rem non-empty file = something to say; print it verbatim (version text may contain | > etc.)
echo.
type "%MSGFILE%"
echo.
rem Only the UPD prefix (kernel update inside the shell compat range) asks Y/N.
rem KERN (kernel beyond the shell range) and FROZEN lines are display-only: answering Y there
rem would push update-all onto a kernel the shell is not adapted for (2026-11-12 compat report).
rem A display-only notice still has to be READABLE: start-desktop.cmd launches the app right after
rem this script, so the console closes about a second later. Without a hold, 13 days of KERN notices
rem went by unseen (2026-11-26 report). KERN now holds the window for 5s; FROZEN is the user's own
rem deliberate state and repeats every launch, so it stays quiet.
set "UPDLINE="
for /f "usebackq tokens=1 delims=" %%A in ("%MSGFILE%") do if not defined UPDLINE set "UPDLINE=%%A"
if /i "%UPDLINE:~0,4%"=="UPD " goto upd_ask
if /i "%UPDLINE:~0,6%"=="FROZEN" goto :eof
rem Hold exactly ~5s so the notice can be read. timeout is the canonical waiter but fails when
rem stdin is redirected (launched from another script/terminal); ping -n 6 covers that case.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key kernel-hold
timeout /t 5 /nobreak >nul 2>nul
if errorlevel 1 ping -n 6 127.0.0.1 >nul 2>nul
goto :eof
:upd_ask
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-prompt -NoNewline
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-hint
choice /C YN /T 15 /D N /N /M " > "
if errorlevel 2 goto :eof
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" update-all -Force
if errorlevel 1 (
  echo.
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-failed
  pause
)
goto :eof
