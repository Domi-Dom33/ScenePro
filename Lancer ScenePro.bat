@echo off
chcp 65001 >nul
title ScenePro - serveur de regie et de diffusion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js est necessaire pour ScenePro ^(diffusion en ligne, entrees live, telecommandes^).
  echo  Installez-le depuis https://nodejs.org puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\ws" (
  echo  Premiere utilisation : installation des composants ^(ffmpeg, etc.^)...
  call npm install --omit=dev --no-audit --no-fund
)

rem Le serveur ouvre automatiquement la regie dans Microsoft Edge.
rem Gardez cette fenetre ouverte pendant le show (vous pouvez la reduire).
node server.js
pause
