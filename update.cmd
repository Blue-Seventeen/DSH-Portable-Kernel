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
rem     Chinese strings live in tools\say.ps1;
rem   - do not add dependencies: only env.cmd, tools\say.ps1,
rem     tools\shell-update.mjs, dsh-portable.ps1 and runtime\node are allowed;
rem   - only use shell-update flags that every version understands, and probe
rem     optional ones (--notice) instead of assuming them: an old shell must
rem     still be upgradeable by a NEW update.cmd, and vice versa;
rem   - logic that may need to change belongs in tools\shell-update.mjs, which
rem     node loads and closes, so the updater can replace its own code safely
rem     (a running .cmd cannot be replaced safely).
rem
rem Flow: check -> one-line verdict -> ask Y/N -> wait for the desktop to exit
rem -> apply -> done. Never touches app/desktop/runtime or user data.
rem ===========================================================================
chcp 65001 >nul 2>nul
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%env.cmd" goto no_env
call "%ROOT%env.cmd"
set "NODE=%ROOT%runtime\node\bin\node.exe"
set "SU=%ROOT%tools\shell-update.mjs"
if not exist "%NODE%" goto no_runtime
if not exist "%SU%" goto no_tool
if not exist "%ROOT%tmp" mkdir "%ROOT%tmp" >nul 2>nul
set "VERDICT=%ROOT%tmp\update-entry.txt"

echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-shell-header
echo.

rem --- capability probe: --notice (compact, one line) only exists from 0.6.0 ---
rem an old shell answers "usage error" (2); then fall back to the verbose --brief
if exist "%VERDICT%" del "%VERDICT%" >nul 2>nul
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-shell-checking
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
if not defined LINE goto up_to_date
echo   %LINE%
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
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-shell-ask
choice /C YN /T 20 /D Y /N /M " > "
if errorlevel 2 goto declined

rem --- shell files can only be replaced while the desktop is closed ----------
set /a TRIES=0
:wait_desktop
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" show-desktop >nul 2>&1
if "%ERRORLEVEL%"=="2" goto do_apply
set /a TRIES+=1
if %TRIES% GEQ 1 powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-shell-close-first
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
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-shell-ok
echo.
pause
endlocal & exit /b 0

:up_to_date
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-shell-uptodate
echo.
timeout /t 6 /nobreak >nul 2>nul
if errorlevel 1 ping -n 7 127.0.0.1 >nul 2>nul
endlocal & exit /b 0

:blocked
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-shell-blocked
echo.
pause
endlocal & exit /b 3

:net_fail
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-shell-netfail
echo.
pause
endlocal & exit /b 1

:declined
"%NODE%" "%SU%" snooze >nul 2>nul
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-shell-declined
echo.
timeout /t 4 /nobreak >nul 2>nul
if errorlevel 1 ping -n 5 127.0.0.1 >nul 2>nul
endlocal & exit /b 0

:gave_up
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key update-shell-gaveup
echo.
pause
endlocal & exit /b 1

:apply_failed
echo.
if "%RC%"=="3" (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key cmd-blocked -Value %RC%
) else (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key cmd-failed -Value %RC%
)
echo.
pause
endlocal & exit /b %RC%

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
echo   [X] tools\shell-update.mjs is missing, so the shell cannot update itself.
echo       Download harness-shell-*.zip from the Release page and unpack it
echo       over this folder, then run this file again.
echo.
pause
exit /b 1
