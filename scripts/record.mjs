// 30초 화면 녹화본 만들기 (macOS): 헤드리스 Chrome 화면 + 같은 음성 파일로 음성 트랙
// 生成 30 秒录屏（macOS）：无头 Chrome 画面 + 用同一批语音文件合成音轨
//
//   node scripts/record.mjs [out.mp4] [seconds]
//
// 앱을 ?tts=say 모드로 열면 각 문장을 macOS `say`(Yuna) 로 만든 WAV 로 재생하고 시작 시각을 기록한다.
// 녹화가 끝나면 그 시각에 같은 WAV 를 배치해 영상과 합친다 → 입 모양·말풍선과 음성이 정확히 맞음.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.resolve(process.argv[2] || path.join(root, 'submission', 'screen-recording.mp4'))
const SECONDS = Number(process.argv[3] || 29)
const PORT = 5399
const CDP_PORT = 9339
const W = 1440, H = 900
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-rec-'))
const children = []
const cleanup = () => children.forEach((c) => { try { c.kill() } catch {} })
process.on('exit', cleanup)

// 1. 서버 / 服务器
children.push(spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' }))
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/__api/health`)).ok) break } catch {}
  if (i > 50) throw new Error('server did not start')
  await sleep(200)
}

// 2. Chrome
children.push(spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'profile')}`,
  `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' }))
let wsUrl
for (let i = 0; !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch {}
  if (i > 50) throw new Error('chrome did not start')
  if (!wsUrl) await sleep(200)
}

// 3. CDP
const ws = new WebSocket(wsUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
const listeners = []
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  else listeners.forEach((fn) => fn(msg))
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `http://localhost:${PORT}/__avatar/?tts=say` })
console.log('앱 준비 대기 / 等待 App 就绪…')
for (let i = 0; ; i++) {
  if (await evaluate(`!!(window.__slate?.script && !document.getElementById('dock').hidden && document.getElementById('loader').hidden)`)) break
  if (i > 600) throw new Error('app not ready (script?)')
  await sleep(500)
}
await sleep(1200)

// 4. 녹화 / 录制
const frames = []
listeners.push((msg) => {
  if (msg.method !== 'Page.screencastFrame') return
  const { data, metadata, sessionId } = msg.params
  frames.push({ t: metadata.timestamp * 1000, data })
  send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})
await send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: W, maxHeight: H })
await sleep(600)
await evaluate(`document.getElementById('btn-play').click()`)
const firstFrame = () => frames[0]?.t ?? Date.now()
while (Date.now() - firstFrame() < SECONDS * 1000) await sleep(200)
await send('Page.stopScreencast')
const log = await evaluate(`window.__ttsLog.map((e) => ({ text: e.text, t: performance.timeOrigin + e.t }))`)
const rate = await evaluate(`Number(document.getElementById('rate').value)`)
const t0 = frames[0].t
const end = t0 + SECONDS * 1000
console.log(`frames: ${frames.length}, utterances: ${log.length}`)

// 5. 프레임 → 영상 / 帧 → 视频
const list = []
frames.forEach((f, i) => {
  const file = path.join(tmp, `f${String(i).padStart(5, '0')}.jpg`)
  fs.writeFileSync(file, Buffer.from(f.data, 'base64'))
  const next = i + 1 < frames.length ? frames[i + 1].t : end
  if (f.t < end) list.push(`file '${file}'\nduration ${Math.max(0.001, (Math.min(next, end) - f.t) / 1000).toFixed(4)}`)
})
list.push(`file '${path.join(tmp, `f${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`)
fs.writeFileSync(path.join(tmp, 'frames.txt'), list.join('\n'))

// 6. 음성 트랙 / 音轨
const inputs = [], filters = []
for (const [i, e] of log.entries()) {
  const delay = Math.round(e.t - t0)
  if (delay >= SECONDS * 1000) continue
  const wav = path.join(tmp, `a${i}.wav`)
  fs.writeFileSync(wav, Buffer.from(await (await fetch(`http://localhost:${PORT}/__api/tts?rate=${rate}&text=${encodeURIComponent(e.text)}`)).arrayBuffer()))
  inputs.push('-i', wav)
  filters.push(`[${inputs.length / 2}:a]adelay=${Math.max(0, delay)}:all=1[a${i}]`)
}
const labels = filters.map((f) => f.match(/\[(a\d+)\]$/)[0]).join('')
const audioFilter = filters.length
  ? `${filters.join(';')};${labels}amix=inputs=${filters.length}:normalize=0,apad,atrim=0:${SECONDS},afade=t=out:st=${SECONDS - 0.8}:d=0.8[aout]`
  : `anullsrc=r=24000:cl=mono,atrim=0:${SECONDS}[aout]`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'frames.txt'),
  ...inputs,
  '-filter_complex', `[0:v]fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p[vout];${audioFilter}`,
  '-map', '[vout]', '-map', '[aout]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-c:a', 'aac', '-b:a', '160k',
  '-t', String(SECONDS), '-movflags', '+faststart', OUT,
], { stdio: 'inherit' })
console.log(`✓ ${OUT}`)
ws.close()
cleanup()
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(0)
