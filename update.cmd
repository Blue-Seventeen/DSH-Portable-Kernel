@echo off
rem ===========================================================================
rem FROZEN FILE - TREAT AS READ-ONLY.
rem
rem This is the permanent upgrade entry of DSH-Portable-Kernel.
rem Its NAME, its BEHAVIOUR and its DEPENDENCY LIST must never change.
rem Reason: an installed copy can only know what it shipped with. Any rename,
rem move or rewrite breaks the update path for every older install, and those
rem installs can never be reached again by a later release.
rem
rem Therefore:
rem   - keep this file pure ASCII (a double-clicked .cmd is parsed with the OEM
rem     code page; Chinese text here once got re-parsed as a command) - all
rem     Chinese strings live in tools\lib\say.ps1;
rem   - do not add dependencies: only env.cmd, tools\lib\say.ps1,
rem     tools\update\shell-update.mjs, dsh-portable.ps1 and runtime\node are allowed;
rem   - only use shell-update flags that every version understands, and probe
rem     optional ones (--notice) instead of assuming them: an old shell must
rem     still be upgradeable by a NEW update.cmd, and vice versa;
rem   - logic that may need to change belongs in tools\update\shell-update.mjs, which
rem     node loads and closes, so the updater can replace its own code safely
rem     (a running .cmd cannot be replaced safely).
rem
rem Flow: check -> one-line verdict -> ask Y/N -> wait for the desktop to exit
rem -> apply -> done. Never touches app/desktop/runtime or user data.
rem ===========================================================================
chcp 65001 >nul 2>nul
setlocal enabledelayedexpansion
set "ROOT=%~dp0"
if not exist "%ROOT%env.cmd" goto no_env
call "%ROOT%env.cmd"
set "NODE=%ROOT%runtime\node\bin\node.exe"
set "SU=%ROOT%tools\update\shell-update.mjs"
if not exist "%NODE%" goto no_runtime
if not exist "%SU%" goto no_tool
if not exist "%ROOT%tmp" mkdir "%ROOT%tmp" >nul 2>nul
set "VERDICT=%ROOT%tmp\update-entry.txt"

echo.
call :say update-shell-header
if not defined SAYOK echo   [shell self-update] replaces shell files only (cmd / ps1 / tools). App, desktop, runtime and your settings are untouched.
echo.

rem --- capability probe: --notice (compact, one line) only exists from 0.6.0 ---
rem an old shell answers "usage error" (2); then fall back to the verbose --brief
if exist "%VERDICT%" del "%VERDICT%" >nul 2>nul
call :say update-shell-checking
if not defined SAYOK echo   Checking for updates... (up to ~15s on a slow link, do not close this window)
"%NODE%" "%SU%" check --cached 0 --notice --quiet-fail > "%VERDICT%" 2>nul
set "CHK=%ERRORLEVEL%"
if "%CHK%"=="2" goto legacy

set "LINE="
for /f "usebackq delims=" %%A in ("%VERDICT%") do if not defined LINE set "LINE=%%A"
if "%CHK%"=="4" goto up_to_date
if "%CHK%"=="3" goto blocked
if "%CHK%"=="1" goto net_fail
if "%CHK%"=="0" goto have_line
goto net_fail

:have_line
rem When local shell files were hand-edited, --notice prints nothing (that is a
rem repair case, not an upgrade) - treat it as up to date instead of showing
rem a confusing "x.y.z -> x.y.z".
rem Delayed expansion (!LINE!) is REQUIRED here: --notice prints "SHELL x -> y", and with
rem plain %LINE% cmd parses that ">" as a redirect - the version line vanishes AND a junk
rem file named like "0.6.3(3" appears in the portable folder (measured 2026-11-27).
if not defined LINE goto up_to_date
echo   !LINE!
goto ask

:legacy
rem 0.5.x and older have no --notice; they only understand --brief (verbose,
rem once only - that is the one-time migration path).
"%NODE%" "%SU%" check --cached 0 --brief --quiet-fail
set "CHK=%ERRORLEVEL%"
if "%CHK%"=="4" goto up_to_date
if "%CHK%"=="3" goto blocked
if "%CHK%"=="1" goto net_fail
if not "%CHK%"=="0" goto net_fail

:ask
echo.
call :say update-shell-ask
if not defined SAYOK echo   Upgrade now? Press Y to start; press N or wait 20s to skip (no reminder for 7 days).
rem Default MUST be N: with stdin redirected (script / scheduled task) choice returns the
rem default immediately instead of waiting 20 s, so a Y default would silently auto-upgrade.
choice /C YN /T 20 /D N /N /M " > "
if errorlevel 2 goto declined

rem --- shell files can only be replaced while the desktop is closed ----------
set /a TRIES=0
:wait_desktop
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" show-desktop >nul 2>&1
if "%ERRORLEVEL%"=="2" goto do_apply
set /a TRIES+=1
rem Say it only once: this line used to sit inside the loop and printed the same
rem sentence 60 times in a row (measured 2026-11-27).
call :say update-shell-close-first
if not defined SAYOK echo   DeepSeek is still running: close its window AND quit the tray icon. Continuing automatically once it is gone...
if %TRIES% GEQ 60 goto gave_up
timeout /t 3 /nobreak >nul 2>nul
if errorlevel 1 ping -n 4 127.0.0.1 >nul 2>nul
goto wait_desktop

:do_apply
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" shell-update apply -Force
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto apply_failed
echo.
call :say update-shell-ok
if not defined SAYOK echo   Upgrade finished. The version line above is what you are running now.
echo.
pause
endlocal & exit /b 0

:up_to_date
echo.
call :say update-shell-uptodate
if not defined SAYOK echo   The shell is already up to date. Nothing to do.
echo.
timeout /t 6 /nobreak >nul 2>nul
if errorlevel 1 ping -n 7 127.0.0.1 >nul 2>nul
endlocal & exit /b 0

:blocked
echo.
call :say update-shell-blocked
if not defined SAYOK echo   This upgrade cannot be applied automatically (compatibility check failed, see above). On 0.6.1 or older: run node tools\update\shell-update.mjs apply --to 0.6.2 --force first, then double-click update.cmd again. The full zip contains factory home\profiles defaults - back that folder up before overlaying it.
echo.
pause
endlocal & exit /b 3

:net_fail
echo.
call :say update-shell-netfail
if not defined SAYOK echo   Update check failed: no network/blocked, OR your shell is too old to read the new manifest. (1) retry later; (2) on 0.6.1 or older run: node tools\update\shell-update.mjs apply --to 0.6.2 --force, then double-click update.cmd again; (3) only as a last resort unpack harness-shell-*.zip over this folder - BUT it contains factory home\profiles defaults, so back up home\profiles first or your plugin list gets reset.
echo.
pause
endlocal & exit /b 1

:declined
"%NODE%" "%SU%" snooze >nul 2>nul
echo.
call :say update-shell-declined
if not defined SAYOK echo   Skipped. No reminder for 7 days (double-click update.cmd whenever you want it).
echo.
timeout /t 4 /nobreak >nul 2>nul
if errorlevel 1 ping -n 5 127.0.0.1 >nul 2>nul
endlocal & exit /b 0

:gave_up
echo.
call :say update-shell-gaveup
if not defined SAYOK echo   Waited ~4 minutes and DeepSeek is still running, so nothing was changed. Close it and double-click update.cmd again.
echo.
pause
endlocal & exit /b 1

:apply_failed
echo.
if "%RC%"=="3" (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\lib\say.ps1" -Key cmd-blocked -Value %RC%
) else (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\lib\say.ps1" -Key cmd-failed -Value %RC%
)
echo.
pause
endlocal & exit /b %RC%


rem ---------------------------------------------------------------------------
rem :say <key> - print one Chinese line through tools\lib\say.ps1, and remember whether
rem that key exists. An OLD shell ships an OLD say.ps1 without the update-shell-*
rem keys; say.ps1 then prints nothing and still exits 0, so errorlevel cannot be
rem used. Probing the OUTPUT is the only reliable signal - and the caller prints a
rem plain ASCII fallback when SAYOK stays unset (measured 2026-11-27: without this
rem an old shell answered a double-click with a blank screen and exit code 1).
:say
if not exist "%ROOT%tmp" mkdir "%ROOT%tmp" >nul 2>nul
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\lib\say.ps1" -Key %~1 > "%ROOT%tmp\say-line.txt" 2>nul
for %%A in ("%ROOT%tmp\say-line.txt") do if %%~zA GTR 0 set "SAYOK=1"
if exist "%ROOT%tmp\say-line.txt" type "%ROOT%tmp\say-line.txt"
goto :eof
:no_env
echo.
echo   [X] env.cmd is missing next to this file. Run this from the portable folder.
echo.
pause
exit /b 1

:no_runtime
echo.
echo   [X] The bundled runtime is missing: %NODE%
echo       Re-download the full package, or run bootstrap first.
echo.
pause
exit /b 1

:no_tool
echo.
echo   [X] tools\update\shell-update.mjs is missing, so the shell cannot update itself.
echo       Download harness-shell-*.zip from the Release page and unpack it
echo       over this folder, then run this file again.
echo.
pause
exit /b 1
