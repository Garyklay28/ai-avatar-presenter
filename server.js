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

const { generateScript, streamAnswer, hasApiKey, MODEL } = await import('./lib/claude.js')

const PORT = Number(process.env.PORT || 5317)
const SITE = (process.env.PORTFOLIO_URL || 'https://my-portfolio-three-zeta-23.vercel.app').replace(/\/$/, '')
const CACHE_DIR = path.join(here, 'cache')
const CONFIG = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'))

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
    // 대본 검토: 한국어 대본 + 중국어 번역을 나란히 편집 / 讲稿审阅：韩文讲稿与中文译文对照编辑
    const reviewDir = path.join(here, 'review')
    const reviewFile = path.join(reviewDir, 'script-review.json')
    if (req.method === 'POST') {
      const { segments } = await readJson(req)
      const current = JSON.parse(fs.readFileSync(reviewFile, 'utf8'))
      for (const s of segments) Object.assign(current.segments[s.i], { ko: s.ko, zh: s.zh, note: s.note })
      current.savedAt = new Date().toISOString()
      fs.writeFileSync(reviewFile, JSON.stringify(current, null, 2))
      return sendJson(res, 200, { ok: true, savedAt: current.savedAt })
    }
    if (!fs.existsSync(reviewFile)) {
      const script = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'script-latest.json'), 'utf8'))
      const zh = JSON.parse(fs.readFileSync(path.join(reviewDir, 'zh-draft.json'), 'utf8'))
      fs.writeFileSync(reviewFile, JSON.stringify({
        title: script.title,
        scriptCreatedAt: script.createdAt,
        segments: script.segments.map((g, i) => ({ i, stop: g.stop, koOriginal: g.say, ko: g.say, zhOriginal: zh[i] ?? '', zh: zh[i] ?? '', note: '' })),
      }, null, 2))
    }
    return sendJson(res, 200, { ...JSON.parse(fs.readFileSync(reviewFile, 'utf8')), charsPerMinute: CONFIG.charsPerMinute })
  }

  if (url.pathname === '/__api/health') {
    return sendJson(res, 200, { ok: true, hasKey: hasApiKey(), model: MODEL, site: SITE, minutes: CONFIG.talkMinutes, charsPerMinute: CONFIG.charsPerMinute })
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

  if (url.pathname === '/__api/script' && req.method === 'POST') {
    const { outline, regenerate } = await readJson(req)
    const mock = process.env.MOCK_LLM === '1'
    const key = createHash('sha1').update(JSON.stringify({ outline, minutes: CONFIG.talkMinutes, persona: CONFIG.persona, model: MODEL })).digest('hex').slice(0, 12)
    const file = path.join(CACHE_DIR, `${mock ? 'mock-' : ''}script-${key}.json`)
    const latest = path.join(CACHE_DIR, `${mock ? 'mock-' : ''}script-latest.json`)
    if (!regenerate && fs.existsSync(file)) return sendJson(res, 200, { ...JSON.parse(fs.readFileSync(file, 'utf8')), cached: true })
    if (!hasApiKey()) {
      // 키가 없으면 마지막으로 만든 대본을 대신 사용 / 没有 Key 时退回上次生成的讲稿
      if (fs.existsSync(latest)) return sendJson(res, 200, { ...JSON.parse(fs.readFileSync(latest, 'utf8')), cached: true, stale: true })
      return sendJson(res, 400, { error: '.env 에 ANTHROPIC_API_KEY 가 없습니다 / .env 里没有 ANTHROPIC_API_KEY' })
    }
    try {
      const docs = await loadDocs()
      const script = await generateScript({ outline, docs, config: CONFIG })
      const out = { ...script, createdAt: new Date().toISOString(), model: MODEL }
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(out, null, 2))
      fs.writeFileSync(latest, JSON.stringify(out, null, 2))
      return sendJson(res, 200, out)
    } catch (err) {
      console.error('[script]', err)
      return sendJson(res, 500, { error: errorMessage(err) })
    }
  }

  if (url.pathname === '/__api/ask' && req.method === 'POST') {
    const { question, history, outline, current } = await readJson(req)
    if (!hasApiKey()) return sendJson(res, 400, { error: '.env 에 ANTHROPIC_API_KEY 가 없습니다 / .env 里没有 ANTHROPIC_API_KEY' })
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    try {
      const docs = await loadDocs()
      await streamAnswer({ question, history, outline, current, docs, config: CONFIG, onText: (t) => send('text', t) })
      send('done', {})
    } catch (err) {
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
  const profile = path.join(process.env.HOME || process.env.USERPROFILE || here, '.ai-avatar-presenter', 'browser-profile')
  const child = spawn(browser, [
    `--app=${appUrl}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
  ], { stdio: 'ignore', detached: true })
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
