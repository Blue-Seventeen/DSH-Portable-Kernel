@echo off
setlocal
set "ROOT=%~dp0"
call "%ROOT%env.cmd"
rem NOTE: keep this file pure ASCII. cmd.exe parses a double-clicked .cmd with the OEM code page,
rem and UTF-8 text here once got re-parsed as a command. Chinese messages live in tools\say.ps1.
rem marker = machine name + drive letter, so a folder copied to a new machine re-prepares itself
set "KEY=%COMPUTERNAME%_%ROOT:~0,1%"
rem every start (~0.2s, reads a few small files): point pnpm records at this machine
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\fix-pnpm-state.mjs" --quiet
rem every start: warn (never block) when the profile node_modules was built by a different pnpm
rem major than the one we ship - pnpm then refuses every install and uninstall (store v10 vs v11)
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\fix-pnpm-state.mjs" --check-store --quiet
if errorlevel 3 powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key store-mismatch
rem every start: keep the plugin market able to see shared-installed plugins
rem (a market self-upgrade overwrites its lib\*.js, so this re-applies the patch; no-op when already patched)
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\patch-market.mjs" --quiet
rem every start: rewrite the version exemption to the CURRENT dsh version. Exact pin only - the
rem official loader rejects "*" and a stale pin makes it silently skip the plugin (npm 0.2.1-rc.5)
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\plugin-shared.mjs" compat-heal --quiet
rem once per machine+location: clear the "downloaded from another computer" mark (SmartScreen)
if not exist "%ROOT%tmp\prep-%KEY%.flag" powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" auto-prepare >nul 2>&1
call "%ROOT%check-update.cmd"
if not exist "%ROOT%logs" mkdir "%ROOT%logs" >nul 2>&1
set "RC=0"
rem First ask whether it is already running. Starting a second instance is useless: the official
rem single-instance lock kills it, and its log redirect collides with the file already opened by
rem the first instance - which is exactly why "double click did nothing" used to happen.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" show-desktop >nul 2>&1
if errorlevel 3 goto dsh_focus
if errorlevel 2 goto dsh_start
goto dsh_done
:dsh_start
rem The desktop app inherits this console and keeps it alive (its dsh-host child writes here),
rem so the launcher black box would stay open for the whole session. Redirect its output to a
rem log file instead (masked by tools\mask-log.mjs): the window closes by itself, log is kept.
rem Set DSH_PORTABLE_KEEP_CONSOLE=1 to get the old behaviour (see the log live in the console).
if "%DSH_PORTABLE_KEEP_CONSOLE%"=="1" (
  start "" "%ROOT%desktop\DeepSeek Harness.exe" --user-data-dir="%ROOT%shell-profile"
) else (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" launch-desktop
  if errorlevel 1 (
    set "RC=1"
    start "" "%ROOT%desktop\DeepSeek Harness.exe" --user-data-dir="%ROOT%shell-profile"
  )
)
rem once per machine: make sure the window appears by itself (not only a tray icon)
if not exist "%ROOT%tmp\focus-ok-%KEY%.flag" (
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" focus-desktop
  if errorlevel 2 set "RC=2"
)
goto dsh_done
:dsh_focus
rem The process is up but has no main window yet (just starting, or only a tray icon).
rem Do NOT start a second instance: the official single-instance lock would kill it and the user
rem would see nothing at all. Ask the running instance to show its own window instead.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" focus-desktop
if errorlevel 2 set "RC=2"
:dsh_done
endlocal & exit /b %RC%