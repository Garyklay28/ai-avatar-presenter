#!/bin/bash
# "AI Avatar Presenter.app" 만들기 (프로젝트 폴더 안에 생성) / 生成 macOS App 包（放在项目根目录）
set -e
cd "$(dirname "$0")/.."
APP="AI Avatar Presenter.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/MacOS/AI Avatar Presenter" <<'SH'
#!/bin/bash
# App 이 놓인 폴더 = 프로젝트 폴더 / App 所在文件夹 = 项目文件夹
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
LOG="$HOME/.ai-avatar-presenter/server.log"
mkdir -p "$(dirname "$LOG")"
if ! command -v node >/dev/null; then
  osascript -e 'display dialog "Node.js 20.12 이상이 필요합니다.\n需要 Node.js 20.12+\n\nhttps://nodejs.org" buttons {"OK"} with icon caution'
  open "https://nodejs.org/ko/download"; exit 1
fi
[ -d node_modules ] || npm install --omit=dev >>"$LOG" 2>&1
exec node server.js --open --quit-with-window >>"$LOG" 2>&1
SH
chmod +x "$APP/Contents/MacOS/AI Avatar Presenter"

cat > "$APP/Contents/Info.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>AI Avatar Presenter</string>
  <key>CFBundleDisplayName</key><string>AI Avatar Presenter</string>
  <key>CFBundleIdentifier</key><string>me.yuhuaguo.ai-avatar-presenter</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>AI Avatar Presenter</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
PL

# 아이콘 / 图标 (public/icon.svg → AppIcon.icns)
TMP="$(mktemp -d)"
qlmanage -t -s 1024 -o "$TMP" public/icon.svg >/dev/null 2>&1 || true
if [ -f "$TMP/icon.svg.png" ]; then
  mkdir -p "$TMP/AppIcon.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$TMP/icon.svg.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$TMP/icon.svg.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$TMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
fi
rm -rf "$TMP"
echo "✓ $APP"
