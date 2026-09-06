@echo off
setlocal
pushd "%~dp0"

set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if defined NODE_EXE goto node_ready

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE_EXE%" goto node_ready

echo [ERROR] Node.js executable was not found.
popd
exit /b 1

:node_ready
"%NODE_EXE%" "integration\checkpoint_campaign\run-live-campaign.mjs" %*
set "RUN_EXIT=%ERRORLEVEL%"
popd
exit /b %RUN_EXIT%
