@echo off
rem Double-click to open TwinSpin on your phone: starts the local server and a free Cloudflare https link,
rem then shows the link and a QR code to scan. Options: -Port 8101, -NoQr, -Qr LINK (only print a QR code for LINK).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0phone-link.ps1" %*
if errorlevel 1 pause
