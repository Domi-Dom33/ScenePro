@echo off
chcp 65001 >nul
title ScenePro - poste Enregistrement
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js est necessaire en mode sans installation. Installez ScenePro, ou Node.js depuis https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\ws" call npm install --omit=dev --no-audit --no-fund
node recorder.js
pause
