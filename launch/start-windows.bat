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
rem process.loadEnvFile 때문에 Node 20.12 이상 필요 / 因为用了 process.loadEnvFile，需要 Node 20.12+
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=12)?0:1)"
if errorlevel 1 (
  echo Node.js 버전이 너무 오래됐어요. 20.12 이상으로 업데이트하세요 / Node.js 版本太旧，需要 20.12+ : https://nodejs.org
  start https://nodejs.org/ko/download
  pause
  exit /b 1
)
if not exist node_modules call npm install --omit=dev
echo 이 검은 창을 닫으면 앱 서버가 꺼집니다. 발표 중에는 열어 두세요. / 关闭这个黑色窗口会停止 App 服务器，发表时请保持打开。
node server.js --open --quit-with-window
