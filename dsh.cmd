@echo off
setlocal
set "ROOT=%~dp0"
call "%ROOT%env.cmd"
"%ROOT%runtime\node\bin\node.exe" "%ROOT%app\node_modules\@deepseek-ai\dsh\lib\bin.js" %*
endlocal
