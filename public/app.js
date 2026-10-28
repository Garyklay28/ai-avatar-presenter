// 앱 진행: 사이트 읽기 → 대본 → 발표 → 질의응답
// App 流程：读网站 → 讲稿 → 发表 → 问答
import { createAvatar } from './avatar.js'
import { createReader } from './reader.js'
import { createSpeaker, splitSentences, sttSupported, listenOnce } from './speech.js'

const $ = (id) => document.getElementById(id)
const iframe = $('site')
const avatar = createAvatar($('avatar'))
const reader = createReader(iframe)
const speaker = createSpeaker({
  onStart: (text) => { avatar.setState('speaking'); avatar.say(text) },
  onEnd: () => avatar.setState('idle'),
  onBoundary: () => avatar.pulse(),
})

const state = {
  outline: [],
  script: null,
  seg: 0, // 현재 segment / 当前段
  sentence: 0, // segment 안의 문장 / 段内句子
  playing: false,
  qa: [], // {role, content}
  busy: false, // 질문 처리 중 / 正在回答
  listener: null,
}
window.__slate = state // 디버그용 / 调试用

// ---------- UI helpers ----------
function toast(msg, ms = 6000) {
  const t = $('toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (t.hidden = true), ms)
}
const loaderStep = (msg) => ($('loader-step').textContent = msg)

function renderProgress() {
  const n = state.script?.segments.length ?? 0
  $('progress').textContent = `${Math.min(state.seg + 1, n)} / ${n}`
  $('btn-play').textContent = state.playing ? '⏸ 일시정지' : state.seg > 0 && state.seg < n ? '▶ 이어서' : '▶ 발표 시작'
  document.querySelectorAll('#script-list li').forEach((li, i) => li.classList.toggle('is-now', i === state.seg))
  document.querySelector('#script-list li.is-now')?.scrollIntoView({ block: 'nearest' })
}

function renderScript() {
  const s = state.script
  $('script-title').textContent = s.title
  const chars = s.segments.reduce((n, g) => n + g.say.length, 0)
  $('script-meta').textContent = `${s.segments.length} segments · ${chars.toLocaleString()}자 · 약 ${Math.round(chars / 330 / speaker.rate)}분${s.cached ? ' · cached' : ''}${s.stale ? ' (오프라인: 이전 대본 / 离线：上次讲稿)' : ''}`
  const ol = $('script-list')
  ol.innerHTML = ''
  s.segments.forEach((g, i) => {
    const li = document.createElement('li')
    li.dataset.stop = g.stop
    li.textContent = g.say
    li.onclick = () => jumpTo(i, true)
    ol.appendChild(li)
  })
  renderProgress()
}

function addQa(q, a) {
  const li = document.createElement('li')
  li.innerHTML = `<div class="t"></div><div class="q"></div><div class="a"></div>`
  li.querySelector('.t').textContent = new Date().toLocaleTimeString()
  li.querySelector('.q').textContent = q
  li.querySelector('.a').textContent = a
  $('qa-list').prepend(li)
  return li.querySelector('.a')
}

// ---------- 마우스 따라오기 (iframe 안 포함) / 跟随鼠标（包括 iframe 内） ----------
window.addEventListener('mousemove', (e) => avatar.follow(e.clientX, e.clientY))
function hookIframe() {
  const w = iframe.contentWindow
  const fr = iframe.getBoundingClientRect()
  w.addEventListener('mousemove', (e) => avatar.follow(e.clientX + fr.left, e.clientY + fr.top))
  w.addEventListener('keydown', onKey)
  w.addEventListener('scroll', () => avatar.setAnchor(reader.focusRect()), { passive: true })
}

// ---------- 발표 / 发表 ----------
const stopById = (id) => state.outline.find((s) => s.id === id)

async function playFrom(seg, sentence = 0) {
  const my = speaker.token
  state.playing = true
  renderProgress()
  const segs = state.script.segments
  for (let i = seg; i < segs.length; i++) {
    state.seg = i
    renderProgress()
    if (sentence === 0 || i !== seg) {
      await reader.goto(stopById(segs[i].stop))
      setTimeout(() => avatar.setAnchor(reader.focusRect()), 700)
    }
    const sentences = splitSentences(segs[i].say)
    for (let k = i === seg ? sentence : 0; k < sentences.length; k++) {
      state.sentence = k
      const ok = await speaker.speakOne(sentences[k])
      if (!ok || my !== speaker.token) return // 멈춤·이동 / 被暂停或跳转
    }
    state.sentence = 0
    await new Promise((r) => setTimeout(r, 350))
    if (my !== speaker.token) return
  }
  // 끝 / 结束
  state.playing = false
  state.seg = segs.length
  renderProgress()
  avatar.say('')
  avatar.setAnchor(null)
}

function pause() {
  state.playing = false
  speaker.cancel()
  avatar.setState('idle')
  renderProgress()
}

function togglePlay() {
  if (!state.script || state.busy) return
  if (state.playing) return pause()
  if (state.seg >= state.script.segments.length) state.seg = 0
  speaker.cancel()
  playFrom(state.seg, state.sentence)
}

function jumpTo(i, play = state.playing) {
  if (!state.script) return
  const n = state.script.segments.length
  i = Math.max(0, Math.min(n - 1, i))
  speaker.cancel()
  state.seg = i
  state.sentence = 0
  if (play) playFrom(i)
  else {
    reader.goto(stopById(state.script.segments[i].stop)).then(() => setTimeout(() => avatar.setAnchor(reader.focusRect()), 700))
    renderProgress()
  }
}

// ---------- 질의응답 / 问答 ----------
async function ask(question) {
  question = question.trim()
  if (!question || state.busy) return
  const wasPlaying = state.playing
  if (wasPlaying) pause()
  state.busy = true
  avatar.setState('thinking')
  avatar.say(`“${question}”`)
  const answerEl = addQa(question, '…')

  const current = state.script?.segments[Math.min(state.seg, state.script.segments.length - 1)]?.stop
  let raw = ''
  let spoken = 0 // 이미 TTS 큐에 넣은 글자 위치 / 已送入 TTS 的位置
  let gotoDone = false
  const queue = []
  let speaking = null
  const my = speaker.token

  const pump = () => {
    if (speaking || !queue.length) return
    const s = queue.shift()
    speaking = speaker.speakOne(s).then((ok) => {
      speaking = null
      if (ok && my === speaker.token) pump()
      else queue.length = 0
    })
  }

  const visible = () => raw.replace(/^\s*\[\[goto:[^\]]*\]\]\s*/, '')
  const feed = (final) => {
    if (!gotoDone) {
      const m = raw.match(/^\s*\[\[goto:([^\]]+)\]\]/)
      if (m) {
        gotoDone = true
        const stop = stopById(m[1].trim())
        if (stop) reader.goto(stop).then(() => setTimeout(() => avatar.setAnchor(reader.focusRect()), 700))
      } else if (!/^\s*\[?\[?(g(o(t(o(:[^\]]*\]?)?)?)?)?)?$/.test(raw)) {
        gotoDone = true
      } else if (!final) return
    }
    const text = visible()
    answerEl.textContent = text
    // 완성된 문장만 읽기 시작 / 只把完整的句子送去朗读
    const rest = text.slice(spoken)
    const re = /[^.!?。？！…\n]*[.!?。？！…\n]+["”’)]*\s/g
    let m, end = 0
    while ((m = re.exec(rest))) end = re.lastIndex
    if (final) end = rest.length
    if (end > 0) {
      for (const s of splitSentences(rest.slice(0, end))) queue.push(s)
      spoken += end
      pump()
    }
  }

  try {
    const res = await fetch('/__api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, history: state.qa, outline: state.outline, current }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
    const rd = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await rd.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = block.match(/^event: (.*)$/m)?.[1]
        const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? 'null')
        if (ev === 'text') { raw += data; feed(false) }
        if (ev === 'error') throw new Error(data.error)
      }
    }
    feed(true)
    state.qa.push({ role: 'user', content: question }, { role: 'assistant', content: visible() })
  } catch (err) {
    avatar.setState('idle')
    answerEl.textContent = `⚠ ${err.message}`
    toast(`질문 처리 실패 / 回答失败: ${err.message}`)
  } finally {
    while (speaking || queue.length) await (speaking || new Promise((r) => setTimeout(r, 100)))
    state.busy = false
    if (my === speaker.token) avatar.setState('idle')
    renderProgress()
  }
}

async function micQuestion() {
  if (state.listener) { state.listener.stop(); return }
  if (!sttSupported()) {
    toast('이 브라우저는 음성 인식을 지원하지 않습니다. Chrome/Edge 로 열거나 ⌨ 로 입력하세요.\n此浏览器不支持语音识别，请用 Chrome/Edge 或 ⌨ 打字。')
    return openTyping()
  }
  if (state.playing) pause()
  speaker.cancel()
  avatar.setState('listening')
  avatar.say('질문을 말씀해 주세요 🎤')
  $('btn-mic').classList.add('is-on')
  $('btn-mic').textContent = '■ 그만 듣기'
  try {
    state.listener = listenOnce({ onInterim: (t) => avatar.say(t || '…') })
    const text = await state.listener.promise
    state.listener = null
    resetMic()
    if (text) await ask(text)
    else { avatar.setState('idle'); avatar.say('') }
  } catch (err) {
    state.listener = null
    resetMic()
    avatar.setState('idle')
    toast(err.message === 'not-allowed'
      ? '마이크 권한이 필요합니다. 주소창 왼쪽 아이콘에서 마이크를 허용하세요.\n需要麦克风权限。'
      : `음성 인식 오류 / 语音识别错误: ${err.message}`)
  }
}
function resetMic() {
  $('btn-mic').classList.remove('is-on')
  $('btn-mic').textContent = '🎤 질문'
}

function openTyping() {
  $('ask-form').hidden = false
  $('ask-input').focus()
}

// ---------- 키보드 / 键盘 ----------
function onKey(e) {
  const typing = e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT' || e.target?.tagName === 'TEXTAREA'
  if (typing) {
    if (e.key === 'Escape') { $('ask-form').hidden = true; e.target.blur() }
    return
  }
  if (e.code === 'Space') { e.preventDefault(); micQuestion() }
  else if (e.key === 'p' || e.key === 'P') togglePlay()
  else if (e.key === 'ArrowRight') jumpTo(state.seg + 1)
  else if (e.key === 'ArrowLeft') jumpTo(state.seg - 1)
  else if (e.key === 'Enter') { e.preventDefault(); openTyping() }
  else if (e.key === 'Escape') { state.listener?.abort(); pause(); avatar.say('') }
}
window.addEventListener('keydown', onKey)

// ---------- 버튼 / 按钮 ----------
$('btn-play').onclick = togglePlay
$('btn-prev').onclick = () => jumpTo(state.seg - 1)
$('btn-next').onclick = () => jumpTo(state.seg + 1)
$('btn-mic').onclick = micQuestion
$('btn-type').onclick = openTyping
$('btn-stop').onclick = () => { state.listener?.abort(); pause(); avatar.say('') }
$('btn-panel').onclick = () => ($('panel').hidden = !$('panel').hidden)
$('btn-close').onclick = () => ($('panel').hidden = true)
$('ask-form').onsubmit = (e) => {
  e.preventDefault()
  const q = $('ask-input').value
  $('ask-input').value = ''
  $('ask-form').hidden = true
  ask(q)
}
document.querySelectorAll('.panel__tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.panel__tabs button').forEach((x) => x.classList.toggle('is-on', x === b))
    document.querySelectorAll('.panel__pane').forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab))
  }
})
$('btn-regen').onclick = async () => {
  if (!confirm('대본을 새로 만들까요? (API 사용) / 重新生成讲稿？（会调用 API）')) return
  pause()
  await loadScript(true)
}
$('rate').oninput = (e) => {
  speaker.setRate(Number(e.target.value))
  $('rate-out').textContent = e.target.value
}
$('voice').onchange = (e) => speaker.setVoice(e.target.value)
$('key-form').onsubmit = async (e) => {
  e.preventDefault()
  const res = await fetch('/__api/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: $('key-input').value.trim() }) })
  const data = await res.json()
  $('key-input').value = ''
  if (!res.ok) return toast(data.error)
  $('status').textContent = 'API OK'
  if (!state.script || state.script.stale) await loadScript(false)
  else toast('저장했습니다 / 已保存', 3000)
}
function openSettings() {
  $('panel').hidden = false
  document.querySelector('.panel__tabs [data-tab="settings"]').click()
}
$('btn-test-voice').onclick = () => { speaker.cancel(); speaker.speakOne('안녕하세요, 저는 슬레이트예요. 오늘 포트폴리오를 소개해 드릴게요.') }

function fillVoices() {
  const list = speaker.voices()
  if (!list.length) return
  speaker.pickDefault()
  $('voice').innerHTML = list.map((v) => `<option value="${v.name}">${v.name}${v.localService ? '' : ' (online)'}</option>`).join('')
  $('voice').value = speaker.voice?.name ?? ''
}
speechSynthesis.onvoiceschanged = fillVoices
fillVoices()

// ---------- 시작 / 启动 ----------
async function loadScript(regenerate = false) {
  $('loader').hidden = false
  loaderStep(regenerate || !state.script
    ? 'Claude 가 사이트 내용을 각색해 발표 대본을 쓰는 중…\n(처음 한 번 30초~1분) / Claude 正在改编讲稿…'
    : '대본 불러오는 중… / 加载讲稿…')
  try {
    const res = await fetch('/__api/script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outline: state.outline, regenerate }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    state.script = data
    state.seg = 0
    state.sentence = 0
    renderScript()
  } catch (err) {
    toast(`대본 생성 실패 / 讲稿生成失败: ${err.message}`, 15000)
  } finally {
    $('loader').hidden = true
  }
}

async function boot() {
  const health = await fetch('/__api/health').then((r) => r.json()).catch(() => null)
  $('status').textContent = health ? `${health.model} · API ${health.hasKey ? 'OK' : '키 없음'}` : '서버 연결 실패'
  if (health && !health.hasKey) {
    toast('☰ → 설정에서 Claude API Key 를 넣어 주세요.\n请在 ☰ → 设置 里填入 Claude API Key。', 12000)
    openSettings()
  }

  await new Promise((r) => (iframe.contentDocument?.readyState === 'complete' && iframe.contentDocument.querySelector('#root') ? r() : iframe.addEventListener('load', r, { once: true })))
  hookIframe()
  loaderStep('포트폴리오 사이트를 읽는 중… / 正在读取作品集网站…')
  state.outline = await reader.extractOutline((tab) => loaderStep(`포트폴리오 사이트를 읽는 중… ${tab}\n正在读取作品集网站… ${tab}`))
  if (!state.outline.length) {
    toast('사이트 내용을 읽지 못했습니다 / 未能读取网站内容', 15000)
    $('loader').hidden = true
    return
  }
  await loadScript(false)
  $('dock').hidden = false
  avatar.say(state.script ? '준비됐어요! ▶ 를 누르면 발표를 시작할게요.' : '')
}

boot()
