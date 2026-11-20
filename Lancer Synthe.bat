@echo off
chcp 65001 >nul
title ScenePro Synthe - poste habillage
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js est necessaire pour le poste Synthe.
  echo  Installez-le depuis https://nodejs.org puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

rem Le poste Synthe s'ouvre dans Microsoft Edge, meme si la regie est eteinte.
rem Il se connecte a la regie (sur ce PC ou un autre) des qu'elle est allumee.
rem Gardez cette fenetre ouverte pendant le show (vous pouvez la reduire).
node synthe.js
pause
