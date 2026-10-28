#!/bin/bash
# 더블클릭으로 실행 (macOS) / 双击运行（macOS）
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
if ! command -v node >/dev/null; then
  echo "Node.js 20.12 이상이 필요합니다 → https://nodejs.org  /  需要 Node.js 20.12+"
  open "https://nodejs.org/ko/download"
  read -n 1 -p "아무 키나 누르면 닫힙니다 / 按任意键关闭"; exit 1
fi
# process.loadEnvFile 때문에 Node 20.12 이상 필요 / 因为用了 process.loadEnvFile，需要 Node 20.12+
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=12)?0:1)'; then
  echo "Node.js $(node -v) 는 너무 오래됐어요. 20.12 이상으로 업데이트하세요 → https://nodejs.org  /  Node.js 版本太旧，需要 20.12+"
  open "https://nodejs.org/ko/download"
  read -n 1 -p "아무 키나 누르면 닫힙니다 / 按任意键关闭"; exit 1
fi
[ -d node_modules ] || npm install --omit=dev
echo "이 터미널 창을 닫으면 앱 서버가 꺼집니다. 발표 중에는 열어 두세요. / 关闭这个终端窗口会停止 App 服务器，发表时请保持打开。"
exec node server.js --open --quit-with-window
