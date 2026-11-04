@echo off
setlocal
set "ROOT=%~dp0"
call "%ROOT%env.cmd"
rem NOTE: keep this file pure ASCII (see start-desktop.cmd)
set "KEY=%COMPUTERNAME%_%ROOT:~0,1%"
rem every start: point pnpm records at this machine
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\fix-pnpm-state.mjs" --quiet
rem every start: warn (never block) when the profile node_modules was built by a different pnpm
rem major than the one we ship - pnpm then refuses every install and uninstall (store v10 vs v11)
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\fix-pnpm-state.mjs" --check-store --quiet
if errorlevel 3 powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key store-mismatch
rem every start: apply plugins that were staged while the app was running. This MUST run
rem before patch-market: activation may run pnpm, which rewrites the shared plugin tree.
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\plugin-shared.mjs" activate --quiet
rem every start: keep ALL patch families applied (market path+drain, fs link fallback, pnpm store).
rem An official update replaces those files, so this runs after it and before dsh starts; when a
rem family no longer matches the new official code it only warns (exit 4) and boot continues.
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\patch-all.mjs" --apply --quiet >nul 2>nul
if errorlevel 4 powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\say.ps1" -Key patch-needs-adapt
rem every start: rewrite the version exemption to the CURRENT dsh version. Exact pin only - the
rem official loader rejects "*" and a stale pin makes it silently skip the plugin (npm 0.2.1-rc.5)
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\plugin-shared.mjs" compat-heal --quiet
rem once per machine+location: clear the SmartScreen mark
if not exist "%ROOT%tmp\prep-%KEY%.flag" powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%dsh-portable.ps1" auto-prepare >nul 2>&1
call "%ROOT%check-update.cmd"
"%ROOT%runtime\node\bin\node.exe" "%ROOT%app\node_modules\@deepseek-ai\dsh\lib\bin.js" web %*
rem keep the exit code: endlocal alone would reset it to 0, so automation could never tell failures
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%