# 02 · 앱 형태 조사 / App 形态调研

Status: resolved · 방식 / 方式: research

## Question
Windows·Mac 모두에서 돌고, 음성 인식까지 되는 앱 껍데기는 무엇으로 만들까?
用什么做 App 外壳，才能同时支持 Windows、Mac 和语音识别？

## 후보 / 候选
| 후보 | 장점 | 문제 |
|---|---|---|
| (a) Electron | 진짜 데스크톱 앱 | Electron 의 Chromium 에서는 `webkitSpeechRecognition` 이 Google 음성 서버 키가 없어 `network` 오류 → 음성 질문 불가. 패키지 크기 200MB+ |
| (b) Python (tkinter/PyQt) | 설치형 | 사이트 화면을 띄우고 제어하기 어려움, 음성 인식 라이브러리 별도 |
| (c) **Node 로컬 서버 + Chrome/Edge 앱 모드 창** | Chrome 음성 인식(ko-KR) 그대로 사용, 크기 작음, Win/Mac 동일 코드 | Chrome 또는 Edge 필요 |

## Answer
**(c)**. `node server.js --open` 이 Chrome(없으면 Edge)을 `--app=` 모드로 띄워 주소창 없는 전용 창으로 보이게 한다. 별도 프로필(`–/.ai-avatar-presenter/browser-profile`)이라 평소 Chrome 과 섞이지 않고 마이크 권한도 한 번만 묻는다. Mac 은 `.app` 번들, Windows 는 `.bat` 으로 더블클릭 실행.
选 (c)：用 Chrome/Edge 的 `--app` 模式打开无地址栏的专用窗口，Mac 用 .app、Windows 用 .bat 双击启动。
