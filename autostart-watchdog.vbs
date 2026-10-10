' MiraWatchdog: 隐藏启动看门狗（每 30s 检查 bridge:8787 与 cloudflared，掉了就拉起）
' 定时重启默认关闭（BRIDGE_RESTART_INTERVAL_MS=0）：用户 2026-09-29 要求关掉。
' 想开回来：把下面这行删掉，或改成想要的毫秒数（如 3600000 = 1 小时）。
Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Environment("PROCESS")("BRIDGE_RESTART_INTERVAL_MS") = "0"
shell.Run """C:\Program Files\nodejs\node.exe"" ""E:\test\mira-bridge\tools\watchdog.mjs""", 0, False
