@echo off
rem --- Hack3rX-Harness portable environment (all paths relative to this folder) ---
rem Keep this file pure ASCII (cmd.exe parses it with the OEM code page).
rem
rem Do not inherit a host DSH session. If this folder is started from inside another dsh
rem (or from a shell that exports dsh vars), things like DSH_HOME / DSH_SESSION_ID would
rem point back at the host - the portable copy would write into the host profile, and the
rem desktop app would attach to the host session instead of its own. Switch off the ones
rem we know about; our own DSH_PORTABLE_* switches are left alone on purpose.
for %%V in (DSH_HOME DSH_AGENTS_HOME DSH_PROFILE DSH_SESSION_ID DSH_WORKSPACE DSH_STORAGE DSH_CONFIG DSH_LOG_LEVEL DSH_DEBUG DSH_NO_UPDATE_CHECK) do set "%%V="
rem prevent Electron being mistaken for node when launched from inside a dsh session
set "ELECTRON_RUN_AS_NODE="
set "DSH_HOME=%ROOT%home"
set "DSH_AGENTS_HOME=%ROOT%agents"
set "npm_config_cache=%ROOT%cache\npm"
set "npm_config_userconfig=%ROOT%cache\npmrc"
set "npm_config_store_dir=%LOCALAPPDATA%\Hack3rX-Harness\pnpm-store"
set "PNPM_HOME=%ROOT%cache\pnpm-home"
set "TMP=%ROOT%tmp"
set "TEMP=%ROOT%tmp"
rem only prepend once: every start-*.cmd calls this file again, and repeated prepends
rem would grow PATH until it hits the 8191-character limit
echo "%PATH%" | findstr /i /c:"%ROOT%runtime\node\bin" >nul 2>nul
if errorlevel 1 set "PATH=%ROOT%runtime\node\bin;%ROOT%runtime\pnpm\bin;%ROOT%runtime\vcredist;%PATH%"
if not exist "%LOCALAPPDATA%\Hack3rX-Harness\pnpm-store" mkdir "%LOCALAPPDATA%\Hack3rX-Harness\pnpm-store" >nul 2>nul
if not exist "%ROOT%tmp" mkdir "%ROOT%tmp" >nul 2>nul