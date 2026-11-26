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

rem --- 1) shell self-update notice (one line, cached) ---
rem start-desktop.cmd never upgrades the shell; only the dsh-portable.cmd menu does. Before this
rem version a user who always double-clicks start-desktop.cmd never heard about a new shell at all
rem (2026-11-26). The check is cached for 180 minutes so repeat launches cost no network time.
set "SHELLMSG=%ROOT%tmp\shell-notice.txt"
if exist "%SHELLMSG%" del "%SHELLMSG%" >nul 2>nul
if exist "%ROOT%tools\shell-update.mjs" "%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\shell-update.mjs" check --cached 180 --notice --quiet-fail > "%SHELLMSG%" 2>nul
set "SHELLNOTICE="
for %%F in ("%SHELLMSG%") do if %%~zF GTR 0 set "SHELLNOTICE=1"
if defined SHELLNOTICE (
  echo.
  type "%SHELLMSG%"
  echo.
)

rem --- 2) kernel check ---
set "MSGFILE=%ROOT%tmp\update-check.txt"
if exist "%MSGFILE%" del "%MSGFILE%" >nul 2>nul
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\update-check.mjs" > "%MSGFILE%" 2> "%ROOT%logs\update-check.err"
set "KERNMSG="
if exist "%MSGFILE%" for %%F in ("%MSGFILE%") do if %%~zF GTR 0 set "KERNMSG=1"
if defined KERNMSG (
  echo.
  type "%MSGFILE%"
  echo.
)

rem --- 3) verdict ---
rem Only the UPD prefix (kernel INSIDE the shell compat range) asks Y/N. KERN (kernel beyond the
rem shell range) stays display-only: answering Y there would push update-all onto a kernel the shell
rem is not adapted for (2026-11-12 compat report). FROZEN is the user's own deliberate state and
rem repeats every launch, so it stays quiet. Everything else is held ~5s so it can be read:
rem start-desktop.cmd launches the app right after this script and the console closes with it.
rem First value MUST be a sentinel, never empty: with an empty value the %UPDLINE:~0,4%
rem expansion below becomes empty text and cmd aborts the if with
rem "The syntax of the command is incorrect." (only reachable when the kernel check
rem prints nothing at all - new in 0.6.0, unreachable before).
rem Because the sentinel is a real value, the fill-in below compares against it
rem instead of using 'if not defined' (which would now always be false and kill UPD).
set "UPDLINE=-"
if defined KERNMSG for /f "usebackq tokens=1 delims=" %%A in ("%MSGFILE%") do if "%UPDLINE%"=="-" set "UPDLINE=%%A"
if /i "%UPDLINE:~0,4%"=="UPD " goto upd_ask
if /i "%UPDLINE:~0,6%"=="FROZEN" goto :eof
if defined SHELLNOTICE goto hold
if defined KERNMSG goto hold
goto :eof

:hold
rem timeout is the canonical waiter but fails when stdin is redirected (launched from another
rem script/terminal); ping -n 6 covers that case.
if defined SHELLNOTICE powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key shell-hold
if defined KERNMSG powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key kernel-hold
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
