# AI Avatar Presenter — SLATE

포트폴리오 사이트를 AI 아바타 "슬레이트"(클래퍼보드 캐릭터)가 대신 발표하고, 현장 질문에 음성으로 답하는 앱.
由 AI 头像「슬레이트」（场记板角色）代替本人发表作品集网站，并用语音回答现场提问的 App。

- 대상 사이트 / 目标网站: https://my-portfolio-three-zeta-23.vercel.app (Yuhua Guo — Behind The Image)
- 사람용 사용 설명은 [USER_GUIDE.md](USER_GUIDE.md) / 给人看的使用说明见 USER_GUIDE.md

## 실행 환경 / 运行环境

| 항목 / 项目 | 요구 사항 / 要求 |
|---|---|
| OS | macOS 11+ 또는 / 或 Windows 10+ |
| Node.js | **20.12 이상** (`process.loadEnvFile` 사용) / 20.12 以上 |
| 브라우저 / 浏览器 | **Google Chrome** (권장 / 推荐) 또는 Microsoft Edge — 앱 창(`--app` 모드)과 음성 인식(Web Speech API)에 사용 / 用于 App 窗口和语音识别 |
| 네트워크 / 网络 | 인터넷 연결 필요 (포트폴리오 사이트, Claude API, Chrome 음성 인식) / 需要联网 |
| 마이크 / 麦克风 | 음성 질문용 / 语音提问用 (없으면 ⌨ 글 질문 / 没有就用 ⌨ 打字) |

## 의존성 / 依赖

| 패키지 / 包 | 용도 / 用途 |
|---|---|
| `@anthropic-ai/sdk` ^1.3 | Claude API 호출 (대본 생성 · 스트리밍 답변) / 调用 Claude |
| `zod` ^4 | 대본 JSON 구조 정의 (Structured Outputs) / 定义讲稿 JSON 结构 |

나머지는 Node 내장 모듈(`http`, `fetch`)과 브라우저 내장 API(`speechSynthesis`, `webkitSpeechRecognition`)만 사용. 빌드 단계 없음.
其余只用 Node 内置模块和浏览器内置 API，无需构建。

## 설치 및 실행 / 安装与运行

```bash
git clone https://github.com/Garyklay28/ai-avatar-presenter.git
cd ai-avatar-presenter
npm install
cp .env.example .env        # ANTHROPIC_API_KEY 입력 / 填入 Key
npm start                   # 서버 + Chrome 앱 창 / 服务器 + Chrome App 窗口
```

| 명령 / 命令 | 동작 / 作用 |
|---|---|
| `npm start` | 서버 시작 + 앱 창 열기, 창을 닫으면 서버 종료 / 启动并打开窗口，关窗即退出 |
| `npm run serve` | 서버만 시작 → 브라우저에서 `http://localhost:5317/__avatar/` / 只启动服务器 |
| `npm run mock` | API 없이 화면·음성 흐름만 테스트 (`MOCK_LLM=1`, 확정 대본은 `cache/mock-*` 복사본을 씀) / 不调 API 的测试模式（定稿用 `cache/mock-*` 副本） |
| `npm test` | 사이트 점검 순수 함수(`public/guard.js`) 테스트 / 网站检查纯函数测试 |
| `./launch/build-mac-app.sh` | `AI Avatar Presenter.app` 다시 만들기 / 重新生成 macOS App |
| `node scripts/record.mjs [out.mp4] [초/秒]` | 30초 녹화본 생성 (macOS · Chrome · ffmpeg 필요). 헤드리스 Chrome 화면을 CDP screencast 로 받고, 앱을 `?tts=say` 모드로 돌려 같은 Yuna 음성 WAV 로 음성 트랙을 맞춤 / 生成录屏（需要 macOS · Chrome · ffmpeg） |

더블클릭 실행 / 双击运行:
- macOS: `AI Avatar Presenter.app` (또는 / 或 `launch/start-mac.command`). 처음에는 우클릭 → 열기 (서명되지 않은 앱) / 第一次需右键 → 打开。로그 / 日志: `–/.ai-avatar-presenter/server.log`
- Windows: `launch/start-windows.bat`

첫 실행 시 `node_modules` 가 없으면 자동으로 `npm install --omit=dev` 를 실행합니다. / 首次运行会自动安装依赖。

## 환경변수 / 环境变量 (`.env`)

| 변수 / 变量 | 기본값 / 默认 | 설명 / 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (필수 / 必填) | https://console.anthropic.com → API Keys. 앱의 ☰ → 설정 화면에서 넣어도 `.env` 에 저장됨 / 也可以在 App 设置里填，会写入 `.env` |
| `CLAUDE_MODEL` | `claude-opus-5-5` | 사용할 Claude 모델 / 使用的模型 |
| `CLAUDE_ANSWER_MODEL` | `CLAUDE_MODEL` 과 같음 / 同上 | 질의응답만 다른 모델로 (예: `claude-sonnet-5-5`) / 仅问答换模型 |
| `CLAUDE_FALLBACKS` | (on) | `off` 이면 서버 측 refusal fallback 끔 / 设为 `off` 关闭服务器端 fallback |
| `PORTFOLIO_URL` | `https://my-portfolio-three-zeta-23.vercel.app` | 발표할 사이트 / 要发表的网站 |
| `PORT` | `5317` | 로컬 서버 포트 / 本地端口 |
| `MOCK_LLM` | — | `1` 이면 테스트 모드 / 为 `1` 时是测试模式 |

`.env` 는 `.gitignore` 에 포함되어 저장소에 올라가지 않습니다. / `.env` 不会上传到仓库。

**크레딧 / 余额**: 사이트 + 참고 문서 ≈ 7만 토큰. ▶ 발표 시작 때 이를 1시간 캐시에 미리 써 두고(약 $0.56), 질문 1회는 캐시 읽기 + 출력 300–500 토큰(약 $0.05). 대본 초안 생성 1회는 약 $0.5–1. 발표 전에 https://console.anthropic.com/settings/billing 에서 잔액 확인. / 网站 + 文档约 7 万 token；开始发表时预热 1 小时缓存，每个问题约 $0.05；生成一次草稿约 $0.5–1。发表前请确认余额。

## 구조 / 结构

```
server.js          로컬 서버: 사이트 프록시 · /__api/* · 앱 창 열기 / 本地服务器
lib/claude.js      Claude 프롬프트 · 대본 생성 · 스트리밍 답변 / 提示词与调用
config.json        발표 분량(목표 11분 · 허용 10:30–11:30) · 페르소나 · 참고 문서 / 时长 · 人设 · 参考文档
public/            앱 화면 / App 界面
  app.js           진행 제어 (발표 · 질의응답 흐름 · 사이트 점검 · 단축키) / 流程控制
  reader.js        iframe 안 사이트를 읽고 구역으로 이동 (Supabase 응답 대기) / 读取网站、跳转区域
  guard.js         구역 스냅샷 vs 지금 구역 비교 (순수 함수) / 区域快照对比
  avatar.js        슬레이트 캐릭터 (SVG, 마우스 따라오기, 입 모양) / 角色
  speech.js        TTS · STT (Web Speech API, 최대 15초 듣기) / 语音合成与识别
  review.html      대본 검토 · 승인 페이지 (한·중 대조) / 讲稿审阅与批准页
review/            확정 대본 script-review.json (발표가 읽는 유일한 대본 + 구역 스냅샷) / 定稿
cache/             대본 초안 · 마지막으로 읽은 구역 / 草稿 · 最近读取的区域
tests/             node --test
docs/              앱 자기소개 · 본인 정정 사항 · 발표 당일 체크리스트 · 기획 문서(plan/) / 文档
launch/            더블클릭 실행 파일 / 双击启动文件
```

## 동작 방식 / 工作原理

1. `server.js` 가 포트폴리오 사이트를 `localhost` 로 프록시 → 앱의 iframe 과 같은 출처가 되어 DOM 읽기·탭 클릭·스크롤이 가능.
   服务器把作品集网站代理到 localhost → 与 App 同源，可以读 DOM、点标签页、滚动。
2. `reader.js` 가 4개 탭(Profile · Film · Images · Projects)을 돌며 29개 구역의 텍스트와 상세 설명을 추출.
   依次打开 4 个标签页，提取 29 个区域的文字和详情。
3. 대본: 발표는 본인이 승인한 **확정 대본**(`review/script-review.json`)만 읽는다. `POST /__api/script` 는 구역 + 과제 문서(MD·자막) → Claude (Structured Outputs, `stop` 은 구역 id enum) → `{stop, say, zh}` **대본 초안**을 `cache/` 에 저장할 뿐이고, `review.html` 에서 초안 전체를 승인해야 확정 대본이 바뀐다(중국어로 고친 문단은 "중국어대로 한국어 고치기"로 한국어만 다시 씀).
   讲稿：发表只读本人批准的定稿；生成接口只把草稿存进 cache/，要在审阅页整份批准才替换定稿。
4. 사이트 점검: 확정 대본에 저장된 구역 스냅샷(탭 + 제목)과 지금 읽은 구역을 비교(`guard.js`). 순서가 바뀌면 제목으로 다시 연결하고, 못 찾은 구역은 화면을 움직이지 않고 읽는다. 문제가 있을 때만 「사이트 점검」 창(경고만). 사이트를 못 읽어도(오프라인) 확정 대본으로 발표 가능.
   网站检查：用快照对比当前区域，错位按标题重新对应；有问题才弹窗；离线也能按定稿发表。
5. 발표: 구역으로 스크롤 · 노란 테두리 강조 → 문장 단위 TTS, 아바타 클래퍼가 입처럼 움직이고 말풍선에 자막. ▶ 시작 때 답변용 프롬프트 캐시를 미리 데움(`/__api/warm`, `max_tokens: 0`).
   发表：滚动并高亮 → 逐句朗读；开始时预热回答缓存。
6. 질문: Chrome 음성 인식(한 / 中 / EN, 최대 15초) → `/__api/ask` (SSE 스트리밍, 사이트·문서는 프롬프트 캐시 1시간) → 완성된 문장부터 바로 읽음. 답변 앞의 `[[goto:id]]` 로 관련 구역으로 이동. 답변 중 Space 는 답을 끊고 다시 듣고, 발표 중 질문이었으면 5초 뒤 멈춘 구역의 끊긴 문장부터 자동으로 이어간다. 말하던 중 거절되면 답을 지우고 기록에서 뺀다.
   提问：语音识别（韩/中/英，最长 15 秒）→ 流式回答 → 边生成边朗读；回答中空格打断重听；发表中提问则 5 秒后自动回到暂停处继续。
7. macOS 에서는 앱 창 Chrome 을 `open -na` 로 띄운다. 앱 번들에서 Chrome 을 직접 실행하면 macOS 가 마이크 권한을 번들 기준으로 판단해 무음이 들어온다.
   macOS 上用 `open -na` 启动 Chrome；从 App 包里直接启动会被按包判断麦克风权限，收到静音。
