@echo off
setlocal
set "ROOT=%~dp0"
call "%ROOT%env.cmd"
rem pnpm keeps its content store outside the portable folder: this drive may be exFAT
rem (no symlinks), so the store has to live on NTFS.
rem Only mutating subcommands accept --store-dir, and the subcommand can appear
rem anywhere in the argument list (usually after --profile <name>).
set "STORE=%LOCALAPPDATA%\Hack3rX-Harness\pnpm-store"
if not exist "%STORE%" mkdir "%STORE%" >nul 2>nul
set "NEEDSTORE="
:scan
if "%~1"=="" goto :run
for %%C in (add install i remove rm uninstall un update up import rebuild prune dedupe fetch) do if /i "%~1"=="%%C" set "NEEDSTORE=1"
shift
goto :scan
:run
set "STOREARG="
if defined NEEDSTORE set STOREARG=--store-dir "%STORE%"
rem after moving to another machine/user, node_modules still records the old store path and pnpm
rem refuses to install/uninstall: align the records first
if defined NEEDSTORE "%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\fix-pnpm-state.mjs" --quiet
"%ROOT%runtime\node\bin\node.exe" "%ROOT%app\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin %* %STOREARG%
endlocal
