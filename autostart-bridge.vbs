' MiraBridge: 登录后隐藏启动 relay-only bridge（不启动或重启 newAPI）
' 走 start-8787.cmd 启动，stdout/stderr 落到 bridge.task.log ——
' 2026-09-25 有过一次「服务静默消失」：requests.log 最后一条正常 200，之后端口无人监听，
' 而隐藏启动吞掉了 stderr，查无实据。改成带日志启动后，下次能看到退出码与堆栈。
Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c """"E:\test\mira-bridge\start-8787.cmd""""", 0, False
