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
echo Install Node.js 22.13 or later, or run this project inside the Codex desktop environment.
popd
exit /b 1

:node_ready
if "%~1"=="" goto usage
if /I "%~1"=="help" goto usage
if /I "%~1"=="list" goto usage

set "SCRIPT="
if /I "%~1"=="protocol" set "SCRIPT=packages\atlas_protocol\scripts\verify.mjs"
if /I "%~1"=="runner-core" set "SCRIPT=01_player_runner\scripts\verify.mjs"
if /I "%~1"=="runner-service" set "SCRIPT=01_player_runner\scripts\verify-service.mjs"
if /I "%~1"=="foundry" set "SCRIPT=02_wiki_foundry\scripts\verify.mjs"
if /I "%~1"=="judge" set "SCRIPT=03_replay_judge\scripts\verify.mjs"
if /I "%~1"=="game" set "SCRIPT=integration\quest_atlas\verify.mjs"
if /I "%~1"=="browser" set "SCRIPT=integration\quest_atlas\verify-browser-adapter.mjs"
if /I "%~1"=="live-browser" set "SCRIPT=integration\quest_atlas\live-browser-smoke.mjs"
if /I "%~1"=="desktop-native" set "SCRIPT=04_desktop_bridge\scripts\verify-native.mjs"
if /I "%~1"=="desktop-target" set "SCRIPT=04_desktop_bridge\src\targeting\target-binding-broker.test.mjs"
if /I "%~1"=="desktop-input" set "SCRIPT=04_desktop_bridge\src\input\safe-input-broker.test.mjs"
if /I "%~1"=="desktop" set "SCRIPT=04_desktop_bridge\scripts\verify.mjs"
if /I "%~1"=="desktop-runner" set "SCRIPT=04_desktop_bridge\scripts\verify-player-runner.mjs"
if /I "%~1"=="desktop-boundaries" set "SCRIPT=04_desktop_bridge\scripts\verify-boundaries.mjs"
if /I "%~1"=="windows" set "SCRIPT=04_desktop_bridge\scripts\list-windows.mjs"
if /I "%~1"=="live-window" set "SCRIPT=04_desktop_bridge\scripts\live-window-smoke.mjs"
if /I "%~1"=="pipeline" set "SCRIPT=integration\pipeline\verify.mjs"
if /I "%~1"=="boundaries" set "SCRIPT=scripts\verify-boundaries.mjs"
if /I "%~1"=="all" set "SCRIPT=scripts\test-all.mjs"
if /I "%~1"=="runner" goto runner

if not defined SCRIPT (
  echo [ERROR] Unknown test: %~1
  echo.
  goto usage_error
)

echo [Atlas] Running %~1...
"%NODE_EXE%" "%SCRIPT%"
set "TEST_EXIT=%ERRORLEVEL%"
popd
exit /b %TEST_EXIT%

:runner
echo [Atlas] Running runner-core...
"%NODE_EXE%" "01_player_runner\scripts\verify.mjs"
if errorlevel 1 goto failed
echo [Atlas] Running runner-service...
"%NODE_EXE%" "01_player_runner\scripts\verify-service.mjs"
if errorlevel 1 goto failed
popd
exit /b 0

:failed
set "TEST_EXIT=%ERRORLEVEL%"
popd
exit /b %TEST_EXIT%

:usage
echo Usage: test.cmd TEST_NAME
echo.
echo Available tests:
echo   protocol        Common schema, canonical JSON, hash and signature
echo   runner-core     Player Runner receipt and exact-once core
echo   runner-service  Public tools, lifecycle and sealed persistence
echo   runner          runner-core followed by runner-service
echo   foundry         Evidence import and deterministic Wiki output
echo   judge           Fresh replay, transfer scoring and leak checks
echo   game            Actual Quest Atlas reducer integration
echo   browser         Browser adapter contract with a local mock
echo   live-browser    Legacy CDP Chrome smoke test
echo   desktop-native  Build and self-test the Windows native bridge
echo   desktop-target  Opaque operator target binding and revalidation
echo   desktop-input   Foreground-only bounded input policy
echo   desktop         Generic desktop adapter integration
echo   desktop-runner  Player Runner lifecycle over desktop adapter
echo   desktop-boundaries Assigned module and native API boundaries
echo   windows         List operator-selectable desktop windows
echo   live-window     Real selected-window pixel and key smoke test
echo   pipeline        Runner to Foundry to Judge signed flow
echo   boundaries      Contract Pack and module import boundaries
echo   all             Every non-interactive test; excludes both live smoke tests
popd
exit /b 0

:usage_error
echo Usage: test.cmd TEST_NAME
echo Run test.cmd list to see the names.
popd
exit /b 2
