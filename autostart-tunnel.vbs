' MiraTunnel: 登录后隐藏启动 Cloudflare Tunnel（源站 = 本机 bridge:8787）
' 带 --logfile：以前输出没人接，隧道掉线时查不到原因（2026-09-26 出现过 530）。
Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run """C:\Users\fttawa\bin\cloudflared.exe"" --protocol http2 --config ""C:\Users\fttawa\.cloudflared\mira.yml"" --logfile ""E:\test\mira-bridge\tunnel.log"" --loglevel info tunnel run", 0, False
