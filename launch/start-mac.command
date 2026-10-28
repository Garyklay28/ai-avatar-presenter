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
[ -d node_modules ] || npm install --omit=dev
exec node server.js --open --quit-with-window
