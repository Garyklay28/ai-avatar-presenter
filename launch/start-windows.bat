@echo off
rem 더블클릭으로 실행 (Windows) / 双击运行（Windows）
chcp 65001 >nul
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20.12 이상이 필요합니다 / 需要 Node.js 20.12+ : https://nodejs.org
  start https://nodejs.org/ko/download
  pause
  exit /b 1
)
if not exist node_modules call npm install --omit=dev
node server.js --open --quit-with-window
