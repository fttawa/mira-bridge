@echo off
"C:\Users\fttawa\bin\cloudflared.exe" --protocol http2 --config "C:\Users\fttawa\.cloudflared\mira.yml" tunnel run >> "E:\test\mira-bridge\tunnel.task.log" 2>&1
