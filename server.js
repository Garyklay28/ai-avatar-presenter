// AI 아바타 발표 앱 — 로컬 서버
// AI 头像发表 App —— 本地服务器
//
//   /__avatar/*  앱 화면 (public/)            / App 界面
//   /__api/*     Claude 호출 (키는 서버에만)   / 调用 Claude（Key 只留在服务器）
//   그 밖의 경로  포트폴리오 사이트를 그대로 프록시 → iframe 이 같은 출처가 되어 탭 클릭·스크롤 제어 가능
//   其余路径     原样代理作品集网站 → iframe 同源，App 可以点标签页、滚动页面

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
if (fs.existsSync(path.join(here, '.env'))) process.loadEnvFile(path.join(here, '.env'))

const { generateScript, rewriteKo, streamAnswer, warmAnswerCache, hasApiKey, MODEL, ANSWER_MODEL } = await import('./lib/claude.js')

const PORT = Number(process.env.PORT || 5317)
const SITE = (process.env.PORTFOLIO_URL || 'https://my-portfolio-three-zeta-23.vercel.app').replace(/\/$/, '')
const CACHE_DIR = path.join(here, 'cache')
const CONFIG = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'))
const MOCK = process.env.MOCK_LLM === '1'

// 확정 대본(발표가 읽는 유일한 대본)과 대본 초안(검토 중, cache/) / 定稿（发表唯一读取的讲稿）与草稿（审阅中，cache/）
// MOCK 에서는 진짜 확정 대본을 덮어쓰지 않도록 cache/mock-* 복사본을 쓴다 / MOCK 下用 cache/mock-* 副本，不覆盖真定稿
const APPROVED = MOCK ? path.join(CACHE_DIR, 'mock-script-review.json') : path.join(here, 'review', 'script-review.json')
const DRAFT = path.join(CACHE_DIR, `${MOCK ? 'mock-' : ''}script-draft.json`)
const OUTLINE_LATEST = path.join(CACHE_DIR, 'outline-latest.json') // 앱이 마지막으로 읽은 구역 / App 最近一次读取的区域
if (MOCK && !fs.existsSync(APPROVED)) fs.copyFileSync(path.join(here, 'review', 'script-review.json'), APPROVED)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
}

// ---------- 참고 문서 (과제 MD · 자막) / 参考文档（作业 MD · 字幕） ----------
let docsPromise = null
function loadDocs() {
  docsPromise ??= Promise.all(
    CONFIG.contextDocs.map(async (d) => {
      try {
        // file: 앱 폴더 안 문서 / 应用目录内的文档, path: 포트폴리오 사이트 경로 / 作品集网站路径
        if (d.file) return { ...d, path: d.file, text: fs.readFileSync(path.join(here, d.file), 'utf8') }
        const r = await fetch(SITE + d.path)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return { ...d, text: await r.text() }
      } catch (err) {
        console.warn(`[docs] ${d.path} 불러오기 실패 / 加载失败:`, err.message)
        return null
      }
    }),
  ).then((list) => list.filter(Boolean))
  return docsPromise
}

// ---------- helpers ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

const readFile = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null)
function writeFile(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(data, null, 2))
}
const hash = (v) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12)

// 구역 스냅샷: 대본이 쓰인 때의 구역. used = 대본이 쓰는 구역, 나머지는 「새 구역」 판단용
// 区域快照：讲稿写成时的区域。used = 讲稿用到的区域，其余用来判断「新区域」
function snapshotStops(outline, segments) {
  const used = new Set(segments.map((g) => g.stop))
  return outline.map((s, pos) => ({ id: s.id, tab: s.tab, title: s.title, pos, used: used.has(s.id) }))
}

// 검토 페이지가 쓰는 모양: ko·zh 와 비교용 원문 / 审阅页用的格式：ko·zh 及对比用原文
const reviewSegments = (list) => list.map((g, i) => ({ i, stop: g.stop, koOriginal: g.ko, ko: g.ko, zhOriginal: g.zh ?? '', zh: g.zh ?? '', note: '' }))

function errorMessage(err) {
  if (err?.status === 401) return 'API 키가 올바르지 않습니다 / API Key 无效 (401)'
  if (err?.status === 429) return '요청이 너무 많거나 크레딧이 부족합니다 / 请求过多或余额不足 (429)'
  if (err?.status === 400 && /credit/i.test(err?.error?.error?.message ?? '')) return '크레딧이 부족합니다 / 余额不足'
  return err?.message || String(err)
}

// ---------- API ----------
async function handleApi(req, res, url) {
  if (url.pathname === '/__api/ping') {
    lastPing = Date.now()
    res.writeHead(204); return res.end()
  }

  if (url.pathname === '/__api/review') {
    // 대본 검토: 초안이 있으면 초안, 없으면 확정 대본을 보여 준다. 고치면 항상 초안에 저장 (확정 대본은 승인으로만 바뀜)
    // 讲稿审阅：有草稿显示草稿，否则显示定稿；修改总是存进草稿（定稿只能通过批准改变）
    if (req.method === 'POST') {
      const { segments } = await readJson(req)
      let draft = readFile(DRAFT)
      if (!draft) {
        const a = readFile(APPROVED)
        draft = { title: a.title, createdAt: new Date().toISOString(), source: 'edit', basedOnApprovedAt: a.approvedAt ?? null, segments: reviewSegments(a.segments) }
      }
      for (const s of segments) Object.assign(draft.segments[s.i], { ko: s.ko, zh: s.zh, note: s.note })
      draft.savedAt = new Date().toISOString()
      writeFile(DRAFT, draft)
      return sendJson(res, 200, { ok: true, savedAt: draft.savedAt, createdAt: draft.createdAt, source: draft.source })
    }
    return sendJson(res, 200, {
      approved: readFile(APPROVED),
      draft: readFile(DRAFT),
      charsPerMinute: CONFIG.charsPerMinute,
      talkMinutes: CONFIG.talkMinutes,
      talkRangeMinutes: CONFIG.talkRangeMinutes,
    })
  }

  if (url.pathname === '/__api/review/approve' && req.method === 'POST') {
    // 초안 전체를 한 번에 확정 대본으로 (segment 별로 섞지 않음) / 整份草稿批准为定稿（不按段混合）
    const { createdAt } = await readJson(req)
    const draft = readFile(DRAFT)
    if (!draft) return sendJson(res, 404, { error: '승인할 초안이 없습니다 / 没有可批准的草稿' })
    if (createdAt && createdAt !== draft.createdAt) return sendJson(res, 409, { error: '초안이 바뀌었습니다. 새로 고친 뒤 다시 승인하세요 / 草稿已变化，请刷新后再批准' })
    const prev = readFile(APPROVED)
    if (prev) writeFile(APPROVED.replace(/\.json$/, '.prev.json'), prev) // 직전 확정 대본 백업 / 备份上一版定稿
    // 스냅샷: 생성된 초안은 그때 읽은 구역, 초안 없이 고친 경우는 앱이 마지막으로 읽은 구역 / 快照：生成的草稿用当时区域，直接修改用最近读取的区域
    const outline = readFile(OUTLINE_LATEST)
    const stops = draft.stops ?? (outline?.stops?.length ? snapshotStops(outline.stops, draft.segments) : null)
    const approved = {
      title: draft.title,
      approvedAt: new Date().toISOString(),
      draftCreatedAt: draft.createdAt,
      source: draft.source,
      model: draft.model,
      stopsFrom: draft.stops ? 'draft' : stops ? `outline-latest ${outline.savedAt}` : null,
      stops,
      segments: draft.segments.map(({ stop, ko, zh }, i) => ({ i, stop, ko, zh })),
    }
    writeFile(APPROVED, approved)
    fs.rmSync(DRAFT)
    return sendJson(res, 200, { ok: true, approvedAt: approved.approvedAt, stops: Boolean(stops) })
  }

  if (url.pathname === '/__api/review/discard' && req.method === 'POST') {
    if (fs.existsSync(DRAFT)) fs.renameSync(DRAFT, DRAFT.replace(/\.json$/, '.discarded.json'))
    return sendJson(res, 200, { ok: true })
  }

  if (url.pathname === '/__api/review/rewrite' && req.method === 'POST') {
    // segment 하나의 한국어만 고친 중국어대로 다시 쓰기 → 저장 전에 미리보기 / 只按中文改写一段韩文 → 保存前预览
    const { ko, zh, zhBefore, note } = await readJson(req)
    if (!hasApiKey()) return sendJson(res, 400, { error: '.env 에 ANTHROPIC_API_KEY 가 없습니다 / .env 里没有 ANTHROPIC_API_KEY' })
    try {
      return sendJson(res, 200, { ko: await rewriteKo({ ko, zh, zhBefore, note, config: CONFIG }) })
    } catch (err) {
      console.error('[rewrite]', err)
      return sendJson(res, 500, { error: errorMessage(err) })
    }
  }

  if (url.pathname === '/__api/outline' && req.method === 'POST') {
    // 앱이 읽은 구역 저장 (초안 없이 고친 확정 대본의 스냅샷용) / 保存 App 读到的区域（直接修改定稿时的快照用）
    const { stops, status } = await readJson(req)
    if (stops?.length) writeFile(OUTLINE_LATEST, { savedAt: new Date().toISOString(), status, stops })
    return sendJson(res, 200, { ok: true })
  }

  if (url.pathname === '/__api/health') {
    return sendJson(res, 200, { ok: true, hasKey: hasApiKey(), model: MODEL, answerModel: ANSWER_MODEL, mock: MOCK, site: SITE, minutes: CONFIG.talkMinutes, talkRangeMinutes: CONFIG.talkRangeMinutes, charsPerMinute: CONFIG.charsPerMinute })
  }

  if (url.pathname === '/__api/tts') {
    // 녹화 모드 전용: macOS `say` 로 WAV 생성 (녹화 영상에 같은 음성을 넣기 위해)
    // 仅录屏模式：用 macOS `say` 生成 WAV（让录屏里的声音与画面一致）
    if (process.platform !== 'darwin') return sendJson(res, 501, { error: 'macOS only' })
    const text = url.searchParams.get('text') || ''
    const wpm = Math.round(180 * Number(url.searchParams.get('rate') || 1))
    const voice = url.searchParams.get('voice') || 'Yuna'
    const name = createHash('sha1').update(`${voice}|${wpm}|${text}`).digest('hex').slice(0, 16) + '.wav'
    const dir = path.join(CACHE_DIR, 'tts')
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true })
      await new Promise((resolve, reject) => {
        const p = spawn('say', ['-v', voice, '-r', String(wpm), '-o', file, '--file-format=WAVE', '--data-format=LEI16@24000', text])
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`say exit ${code}`))))
        p.on('error', reject)
      })
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'x-tts-file': name, 'cache-control': 'no-store' })
    return fs.createReadStream(file).pipe(res)
  }

  if (url.pathname === '/__api/key' && req.method === 'POST') {
    // 앱 설정 화면에서 넣은 키를 .env 에 저장 / 把设置界面里填的 Key 写进 .env
    const { key } = await readJson(req)
    if (!/^sk-ant-[\w-]{20,}$/.test(key || '')) return sendJson(res, 400, { error: '키 형식이 올바르지 않습니다 (sk-ant-…) / Key 格式不对' })
    const envFile = path.join(here, '.env')
    const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => !l.startsWith('ANTHROPIC_API_KEY=')) : []
    fs.writeFileSync(envFile, [`ANTHROPIC_API_KEY=${key}`, ...lines.filter(Boolean)].join('\n') + '\n', { mode: 0o600 })
    process.env.ANTHROPIC_API_KEY = key
    return sendJson(res, 200, { ok: true })
  }

  if (url.pathname === '/__api/script' && req.method === 'GET') {
    // 발표는 확정 대본만 읽는다 / 发表只读定稿
    const a = readFile(APPROVED)
    if (!a) return sendJson(res, 404, { error: '확정 대본이 없습니다. 초안을 만들고 검토 페이지에서 승인해 주세요 / 没有定稿，请生成草稿并在审阅页批准' })
    const draft = readFile(DRAFT)
    return sendJson(res, 200, {
      title: a.title,
      approvedAt: a.approvedAt ?? null,
      stops: a.stops ?? null,
      segments: a.segments.map((g) => ({ stop: g.stop, say: g.ko })),
      draft: draft ? { createdAt: draft.createdAt, source: draft.source } : null,
    })
  }

  if (url.pathname === '/__api/script' && req.method === 'POST') {
    // 대본 초안만 만든다 (cache/). 확정 대본은 검토 페이지의 승인으로만 바뀐다 / 只生成草稿（cache/），定稿只能在审阅页批准
    const { outline, regenerate } = await readJson(req)
    if (!outline?.length) return sendJson(res, 400, { error: '사이트 구역이 없어 초안을 만들 수 없습니다 / 没有网站区域，无法生成草稿' })
    if (!hasApiKey()) return sendJson(res, 400, { error: '.env 에 ANTHROPIC_API_KEY 가 없습니다 / .env 里没有 ANTHROPIC_API_KEY' })
    try {
      const docs = await loadDocs()
      // 사이트 · 참고 문서 · 분량 · 속도 · 모델이 같으면 같은 초안 / 网站、参考文档、时长、语速、模型都相同才复用
      const key = hash({ outline, docs: docs.map((d) => [d.path, d.text]), minutes: CONFIG.talkMinutes, range: CONFIG.talkRangeMinutes, charsPerMinute: CONFIG.charsPerMinute, persona: CONFIG.persona, model: MODEL })
      const file = path.join(CACHE_DIR, `${MOCK ? 'mock-' : ''}script-${key}.json`)
      let out = !regenerate && readFile(file)
      if (!out) {
        const script = await generateScript({ outline, docs, config: CONFIG })
        out = { ...script, createdAt: new Date().toISOString(), model: MODEL, stops: snapshotStops(outline, script.segments) }
        writeFile(file, out)
        writeFile(path.join(CACHE_DIR, `${MOCK ? 'mock-' : ''}script-latest.json`), out)
      }
      const draft = {
        title: out.title,
        createdAt: out.createdAt,
        source: 'generated',
        model: out.model,
        stops: out.stops,
        segments: reviewSegments(out.segments.map((g) => ({ stop: g.stop, ko: g.say, zh: g.zh }))),
      }
      if (fs.existsSync(DRAFT)) fs.renameSync(DRAFT, DRAFT.replace(/\.json$/, '.replaced.json')) // 검토 중이던 초안 보관 / 保留被替换的草稿
      writeFile(DRAFT, draft)
      return sendJson(res, 200, { ok: true, createdAt: draft.createdAt, segments: draft.segments.length, chars: draft.segments.reduce((n, g) => n + g.ko.length, 0) })
    } catch (err) {
      console.error('[script]', err)
      return sendJson(res, 500, { error: errorMessage(err) })
    }
  }

  if (url.pathname === '/__api/warm' && req.method === 'POST') {
    // ▶ 발표 시작 때 답변 캐시 미리 데우기. 실패해도 화면에는 알리지 않음 / 开始发表时预热回答缓存，失败不提示
    const { outline } = await readJson(req)
    if (!hasApiKey() || !outline?.length) return sendJson(res, 200, { ok: false })
    try {
      const usage = await warmAnswerCache({ outline, docs: await loadDocs(), config: CONFIG })
      console.log('[warm] usage', JSON.stringify(usage))
      return sendJson(res, 200, { ok: true, usage })
    } catch (err) {
      console.warn('[warm]', errorMessage(err))
      return sendJson(res, 200, { ok: false, error: errorMessage(err) })
    }
  }

  if (url.pathname === '/__api/ask' && req.method === 'POST') {
    const { question, history, outline, current } = await readJson(req)
    if (!hasApiKey()) return sendJson(res, 400, { error: '.env 에 ANTHROPIC_API_KEY 가 없습니다 / .env 里没有 ANTHROPIC_API_KEY' })
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    // 답변 중 Space 로 끊으면 브라우저가 fetch 를 abort → API 스트림도 멈춤 / 回答中按 Space 打断时浏览器 abort → API 流也停止
    const ac = new AbortController()
    res.on('close', () => { if (!res.writableFinished) ac.abort() })
    try {
      const docs = await loadDocs()
      await streamAnswer({
        question, history, outline, current, docs, config: CONFIG, signal: ac.signal,
        onText: (t) => send('text', t),
        onRefusal: () => send('refusal', {}),
        onUsage: (usage) => {
          console.log('[ask] usage', JSON.stringify(usage)) // 10 마이크 테스트: cache_read_input_tokens > 0 확인 / 确认预热生效
          send('usage', usage)
        },
      })
      send('done', {})
    } catch (err) {
      if (ac.signal.aborted) return res.end()
      console.error('[ask]', err)
      send('error', { error: errorMessage(err) })
    }
    return res.end()
  }

  sendJson(res, 404, { error: 'not found' })
}

// ---------- 앱 정적 파일 / App 静态文件 ----------
function serveStatic(res, rel) {
  const file = path.normalize(path.join(here, 'public', rel || 'index.html'))
  if (!file.startsWith(path.join(here, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found')
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(file).pipe(res)
}

// ---------- 포트폴리오 프록시 / 作品集代理 ----------
const DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'x-frame-options', 'content-security-policy', 'strict-transport-security'])

async function proxy(req, res, url) {
  try {
    const upstream = await fetch(SITE + url.pathname + url.search, {
      method: req.method,
      headers: { accept: req.headers.accept || '*/*', 'accept-language': req.headers['accept-language'] || 'ko' },
      redirect: 'follow',
    })
    const headers = {}
    upstream.headers.forEach((v, k) => { if (!DROP.has(k)) headers[k] = v })
    res.writeHead(upstream.status, headers)
    if (req.method === 'HEAD' || !upstream.body) return res.end()
    for await (const chunk of upstream.body) res.write(chunk)
    res.end()
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`포트폴리오 사이트에 연결할 수 없습니다 / 无法连接作品集网站: ${SITE}\n${err.message}`)
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (url.pathname === '/__avatar') { res.writeHead(302, { location: '/__avatar/' }); return res.end() }
    if (url.pathname.startsWith('/__avatar/')) return serveStatic(res, url.pathname.slice('/__avatar/'.length))
    if (url.pathname.startsWith('/__api/')) return await handleApi(req, res, url)
    return await proxy(req, res, url)
  } catch (err) {
    console.error(err)
    if (!res.headersSent) sendJson(res, 500, { error: errorMessage(err) })
    else res.end()
  }
})

// ---------- 앱 창 열기 (Chrome / Edge 앱 모드) / 打开 App 窗口（Chrome / Edge 应用模式） ----------
function findBrowser() {
  const c = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    win32: [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
  }[process.platform] || []
  return c.find((p) => p && fs.existsSync(p))
}

function openAppWindow(appUrl) {
  const browser = findBrowser()
  if (!browser) {
    console.log(`\nChrome/Edge 를 찾지 못했습니다. 브라우저에서 직접 여세요 / 未找到 Chrome/Edge，请手动打开:\n  ${appUrl}\n`)
    return
  }
  if (/edge/i.test(browser)) {
    // 음성 질문(ko-KR)은 정식 Chrome 에서만 안정적 (03 앱 형태) / 语音提问只在正式版 Chrome 上稳定（03）
    console.log('\n⚠ Chrome 이 없어 Microsoft Edge 로 엽니다. 음성 질문이 불안정할 수 있어요 → https://www.google.com/chrome/ 설치를 권장합니다.')
    console.log('⚠ 未找到 Chrome，改用 Edge 打开；语音提问可能不稳定，建议安装 Chrome。\n')
  }
  const profile = path.join(process.env.HOME || process.env.USERPROFILE || here, '.ai-avatar-presenter', 'browser-profile')
  const args = [
    `--app=${appUrl}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
  ]
  // macOS: Chrome 을 직접 spawn 하면 마이크 권한을 「AI Avatar Presenter.app」(또는 터미널) 기준으로 따져서
  // 소리가 0 으로 들어온다(듣기는 시작되지만 글자가 안 나옴). open 으로 띄우면 Chrome 자신의 마이크 권한을 쓴다.
  // macOS：直接 spawn Chrome 时，麦克风权限按「AI Avatar Presenter.app」（或终端）判断，收到的是静音（开始听但没有文字）；
  // 用 open 启动则使用 Chrome 自己的麦克风权限。
  const bundle = process.platform === 'darwin' && browser.match(/^(.*?\.app)\//)?.[1]
  const child = bundle
    ? spawn('open', ['-na', bundle, '--args', ...args], { stdio: 'ignore', detached: true })
    : spawn(browser, args, { stdio: 'ignore', detached: true })
  child.unref()
}

// 앱 창을 닫으면 서버도 종료: Chrome 프로세스는 이미 떠 있는 인스턴스에 창을 넘기고 바로 끝날 수 있어서,
// 프로세스 종료 대신 앱 화면의 heartbeat(/__api/ping)가 끊기는 것으로 판단한다.
// 关掉 App 窗口时服务器退出：Chrome 进程可能把窗口交给已运行的实例后立刻退出，所以改用页面心跳判断。
let lastPing = 0
if (process.argv.includes('--quit-with-window')) {
  setInterval(() => {
    // 창을 최소화하면 Chrome 이 타이머를 1분 간격으로 늦추므로 넉넉하게 3분 / 最小化时 Chrome 会把定时器降到每分钟一次，所以留 3 分钟
    if (lastPing && Date.now() - lastPing > 180000) process.exit(0)
  }, 10000).unref()
}

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err
  // 이미 실행 중이면 창만 다시 연다 / 已在运行时只重新打开窗口
  console.log(`포트 ${PORT} 사용 중 → 기존 서버에 창만 엽니다 / 端口已占用，只打开窗口`)
  if (process.argv.includes('--open')) openAppWindow(`http://localhost:${PORT}/__avatar/`)
  setTimeout(() => process.exit(0), 1500)
})

server.listen(PORT, '127.0.0.1', () => {
  const appUrl = `http://localhost:${PORT}/__avatar/`
  console.log(`AI Avatar Presenter → ${appUrl}`)
  console.log(`  portfolio: ${SITE}`)
  console.log(`  model: ${MODEL} · API key: ${hasApiKey() ? 'OK' : '없음 / 未设置 (.env)'}`)
  if (process.argv.includes('--open')) openAppWindow(appUrl)
})
