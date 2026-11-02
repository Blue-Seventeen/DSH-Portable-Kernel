@echo off
setlocal
set "ROOT=%~dp0"
call "%ROOT%env.cmd"
rem Shared plugin manager: installs each plugin ONCE under home\profiles\node_modules
rem and enables it in both the web and the desktop profile.
rem NOTE: keep this file pure ASCII; Chinese text is printed by tools\plugin-shared.mjs
"%ROOT%runtime\node\bin\node.exe" "%ROOT%tools\plugin-shared.mjs" %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%