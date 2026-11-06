@echo off
:: Run the theater on this machine and open a public https link (Cloudflare quick tunnel, no account)
cd /d "%~dp0"
for /f %%k in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"') do set ROOM_KEY=%%k
set NODE_ENV=production
call npm run build || goto :end
start "watchparty server" cmd /k npm start
echo.
echo Invite link = the https://....trycloudflare.com address shown below + /?key=%ROOM_KEY%
echo Close this window to stop sharing.
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:8080
:end
echo %CMDCMDLINE% | find /i "%~nx0" >nul && pause
