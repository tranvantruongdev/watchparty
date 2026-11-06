@echo off
:: Run the theater on this machine and open a public https link (Cloudflare quick tunnel, no account)
cd /d "%~dp0"
for /f %%k in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"') do set ROOM_KEY=%%k
set NODE_ENV=production
call npm run build || goto :end
start "watchparty server" cmd /k npm start
echo.
echo Close this window to stop sharing. The invite link appears below in green.
echo.
:: Print the full invite link once cloudflared reports its random hostname
start /b powershell -NoProfile -Command "while(1){try{$h=(irm http://127.0.0.1:20241/quicktunnel).hostname; if($h){break}}catch{}; sleep 1}; Write-Host ''; Write-Host ('Invite link: https://'+$h+'/?key=%ROOM_KEY%') -ForegroundColor Green; Write-Host ''"
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --metrics 127.0.0.1:20241 --url http://localhost:8080
:end
echo %CMDCMDLINE% | find /i "%~nx0" >nul && pause
