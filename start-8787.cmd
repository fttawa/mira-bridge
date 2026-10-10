@echo off
setlocal
set "BRIDGE_ENABLE_SESSION_FALLBACK=0"

rem Outbound proxy: default to local Clash Verge mixed port 7897.
rem Node fetch ignores the system proxy; NODE_USE_ENV_PROXY=1 must be set BEFORE node starts.
rem Direct connection: BRIDGE_PROXY=0 . Another port: BRIDGE_PROXY=http://127.0.0.1:7890
rem NOTE 1: keep this file ASCII-only -- cmd.exe runs .cmd in the OEM codepage and
rem         multi-byte comments get mangled into bogus commands.
rem NOTE 2: no output redirection here on purpose. server.mjs writes bridge.task.log
rem         itself (appendFileSync); a `>>` redirect keeps the file handle open for the
rem         whole process lifetime and makes any second instance fail to start.
if not defined BRIDGE_PROXY set "BRIDGE_PROXY=http://127.0.0.1:7897"
if not defined BRIDGE_NO_PROXY set "BRIDGE_NO_PROXY=127.0.0.1,localhost,::1"
if /i not "%BRIDGE_PROXY%"=="0" if /i not "%BRIDGE_PROXY%"=="off" (
  set "NODE_USE_ENV_PROXY=1"
  set "HTTP_PROXY=%BRIDGE_PROXY%"
  set "HTTPS_PROXY=%BRIDGE_PROXY%"
  set "NO_PROXY=%BRIDGE_NO_PROXY%"
)

"C:\Program Files\nodejs\node.exe" "E:\test\mira-bridge\server.mjs"
if errorlevel 1 echo [bridge-launcher] node exited with code %errorlevel% >> "E:\test\mira-bridge\bridge.task.log"
