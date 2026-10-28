// 앱 진행: 사이트 읽기 → 사이트 점검 → 확정 대본 발표 → 질의응답
// App 流程：读网站 → 网站检查 → 按定稿发表 → 问答
import { createAvatar } from './avatar.js'
import { createReader } from './reader.js'
import { createSpeaker, splitSentences, sttSupported, listenOnce } from './speech.js'
import { checkStops } from './guard.js'

const $ = (id) => document.getElementById(id)
const iframe = $('site')
const avatar = createAvatar($('avatar'))
const reader = createReader(iframe)
const speaker = createSpeaker({
  onStart: (text) => {
    avatar.setState('speaking')
    avatar.say(text)
    // 10 마이크 테스트용: 질문이 끝난 순간 → 첫 목소리 / 供 10 麦克风测试：说完 → 首个声音
    const a = state.answer
    if (a && !a.firstVoiceAt) {
      a.firstVoiceAt = performance.now()
      if (a.speechEndAt) a.timing = (a.firstVoiceAt - a.speechEndAt) / 1000
      renderQaMeta(a)
    }
  },
  onEnd: () => avatar.setState('idle'),
  onBoundary: () => avatar.pulse(),
})

const state = {
  outline: [], // 지금 읽은 구역 / 当前读取的区域
  readStatus: null, // 'supabase' | 'timeout' | 'error'
  script: null, // 확정 대본 / 定稿 {title, approvedAt, stops, segments:[{stop, say}], draft}
  check: null, // 사이트 점검 결과 (guard.js) / 网站检查结果
  seg: 0, // 현재 segment / 当前段
  sentence: 0, // segment 안의 문장 / 段内句子
  playing: false,
  resume: null, // 질문으로 멈춘 곳 {seg, sentence} / 因提问暂停的位置
  countdown: null,
  qa: [], // {role, content} — 다음 질문의 대화 기록 / 下一个问题的对话记录
  answer: null, // 진행 중인 답변 / 正在进行的回答
  listener: null,
  lang: 'ko-KR',
  charsPerMinute: 505, // 서버 config 로 덮어씀 / 由服务器 config 覆盖
  talkRange: [10.5, 11.5],
}
window.__slate = state // 디버그용 / 调试用

// 음성 질문 언어: 🎤 옆 버튼 (L) / 语音提问语言：🎤 旁按钮（L）
const LANGS = [
  // 지금 듣는 언어와 바꾸는 법을 함께 보여 줌 (한 으로 둔 채 중국어로 말하면 인식이 안 되거나 엉뚱한 글자가 나옴)
  // 同时显示正在听的语言和切换方法（停在「한」时说中文，会识别不到或变成乱码）
  { code: 'ko-KR', label: '한', listen: '질문을 말씀해 주세요 🎤\n한국어로 듣는 중 · 中文 / EN 은 L' },
  { code: 'zh-CN', label: '中', listen: '请说出你的问题 🎤\n正在听中文 · 换语言按 L' },
  { code: 'en-US', label: 'EN', listen: 'Please ask your question 🎤\nListening in English · L to switch' },
]
const LINES = {
  resume: (n) => `${n}초 뒤 발표를 이어갈게요 · Space 추가 질문`,
  more: '더 궁금한 점 있으면 물어봐 주세요.',
  refused: '이 질문은 여기까지만 답할게요. 다른 질문을 해 주세요.',
  failed: '지금은 답을 가져오지 못했어요. 잠시 뒤 다시 물어봐 주세요.',
  notHeard: '잘 듣지 못했어요. Space 로 다시 말씀해 주세요. 중국어로 물으려면 먼저 L 로 中 을 고르세요.\n没听清，请按空格再说一次；说中文请先按 L 切到「中」。',
}

// ---------- UI helpers ----------
function toast(msg, ms = 6000) {
  const t = $('toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (t.hidden = true), ms)
}
const loaderStep = (msg) => ($('loader-step').textContent = msg)
const fmtMin = (m) => `${Math.floor(m)}분${Math.round((m % 1) * 60) ? ` ${Math.round((m % 1) * 60)}초` : ''}`

function renderProgress() {
  const n = state.script?.segments.length ?? 0
  $('progress').textContent = `${Math.min(state.seg + 1, n)} / ${n}`
  $('btn-play').textContent = state.playing ? '⏸ 일시정지' : (state.seg > 0 || state.sentence > 0) && state.seg < n ? '▶ 이어서' : '▶ 발표 시작'
  document.querySelectorAll('#script-list li').forEach((li, i) => li.classList.toggle('is-now', i === state.seg))
  document.querySelector('#script-list li.is-now')?.scrollIntoView({ block: 'nearest' })
}

function renderScript() {
  const s = state.script
  $('script-title').textContent = s.title
  const chars = s.segments.reduce((n, g) => n + g.say.length, 0)
  const minutes = chars / (state.charsPerMinute * (speaker.rate / 1.15))
  const approved = s.approvedAt ? ` · 확정 ${new Date(s.approvedAt).toLocaleString()}` : ''
  $('script-meta').textContent = `확정 대본 / 定稿 · ${s.segments.length} segments · ${chars.toLocaleString()}자 · 약 ${minutes.toFixed(1)}분${approved}`
  // 목표 시간 밖이면 경고만 (시작은 막지 않음) / 超出目标时长只警告（不拦开始）
  const [lo, hi] = state.talkRange
  const warn = []
  if (minutes < lo || minutes > hi) warn.push(`⚠ 목표 ${fmtMin((lo + hi) / 2)}(${fmtMin(lo)}–${fmtMin(hi)}) 밖이에요. 시작은 할 수 있어요 / 超出目标时长，仍可开始`)
  if (s.draft) warn.push(`📝 승인 전 초안이 있어요 (${new Date(s.draft.createdAt).toLocaleString()}) · 발표는 확정 대본을 읽어요 / 有未批准的草稿，发表仍读定稿`)
  $('script-warn').textContent = warn.join('\n')
  $('script-warn').hidden = !warn.length
  const ol = $('script-list')
  ol.innerHTML = ''
  s.segments.forEach((g, i) => {
    const li = document.createElement('li')
    li.dataset.stop = g.stop
    if (state.check && !state.check.links[g.stop]) li.classList.add('is-lost')
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
  return li
}
function renderQaMeta(a) {
  const parts = [a.time]
  if (a.timing != null) parts.push(`첫 목소리 / 首声 ${a.timing.toFixed(1)}s`)
  if (a.usage) parts.push(`cache read ${a.usage.cache_read_input_tokens ?? '-'} · write ${a.usage.cache_creation_input_tokens ?? '-'}`)
  a.li.querySelector('.t').textContent = parts.join(' · ')
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

// ---------- 화면 이동 / 画面跳转 ----------
// 확정 대본의 구역 → 지금 사이트의 구역 (사이트 점검의 연결표). 못 찾으면 null
// 定稿的区域 → 当前网站的区域（网站检查的对应表）；找不到则 null
const stopForSeg = (i) => state.check?.links[state.script.segments[i].stop] ?? null
// 질의응답의 [[goto:id]] 는 지금 읽은 구역 id 그대로 / 问答的 [[goto:id]] 直接用当前区域 id
const stopById = (id) => state.outline.find((s) => s.id === id)

async function showStop(stop) {
  if (!stop) {
    // 못 찾은 구역: 화면은 그대로, 강조만 지움 / 找不到的区域：画面不动，只去掉高亮
    reader.clearFocus()
    avatar.setAnchor(null)
    return
  }
  await reader.goto(stop)
  setTimeout(() => avatar.setAnchor(reader.focusRect()), 700)
}

// ---------- 발표 / 发表 ----------
async function playFrom(seg, sentence = 0) {
  const my = speaker.token
  state.playing = true
  renderProgress()
  const segs = state.script.segments
  if (seg === 0 && sentence === 0) state.startedAt = performance.now()
  for (let i = seg; i < segs.length; i++) {
    state.seg = i
    state.sentence = i === seg ? sentence : 0
    renderProgress()
    // 이어갈 때도 문장 위치와 상관없이 그 구역으로 (답변이 화면을 옮겼을 수 있음)
    // 继续时不管句子位置都回到该区域（回答可能移动了画面）
    await showStop(stopForSeg(i))
    if (my !== speaker.token) return
    const sentences = splitSentences(segs[i].say)
    for (let k = state.sentence; k < sentences.length; k++) {
      state.sentence = k
      const ok = await speaker.speakOne(sentences[k])
      if (!ok || my !== speaker.token) return // 멈춤·이동 / 被暂停或跳转
    }
    state.sentence = sentences.length // 이 segment 는 다 읽음 (사이에 멈추면 다음 segment 부터) / 本段读完（间隙暂停则从下一段继续）
    await new Promise((r) => setTimeout(r, 350))
    if (my !== speaker.token) return
  }
  // 끝 / 结束
  if (state.startedAt) console.log(`[slate] 발표 시간 / 发表时长: ${((performance.now() - state.startedAt) / 60000).toFixed(2)}분`)
  state.lastRunMs = state.startedAt ? performance.now() - state.startedAt : null
  state.playing = false
  state.seg = segs.length
  state.sentence = 0
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
  if (!state.script || state.answer || state.listener) return
  if (state.resume) return resumeTalk() // 카운트다운 중 P / ▶ = 바로 이어감 / 倒计时中 P / ▶ = 立即继续
  if (state.playing) return pause()
  if (state.seg >= state.script.segments.length) { state.seg = 0; state.sentence = 0 }
  if (state.seg === 0 && state.sentence === 0) warmCache()
  speaker.cancel()
  playFrom(state.seg, state.sentence)
}

function jumpTo(i, play = state.playing) {
  if (!state.script) return
  const n = state.script.segments.length
  i = Math.max(0, Math.min(n - 1, i))
  speaker.cancel()
  cancelCountdown()
  state.resume = null
  state.seg = i
  state.sentence = 0
  if (play) playFrom(i)
  else {
    showStop(stopForSeg(i))
    renderProgress()
  }
}

// ▶ 발표 시작 때 뒤에서 한 번 답변 캐시를 데움 (실패해도 알리지 않음) / 开始发表时后台预热回答缓存（失败不提示）
function warmCache() {
  if (!state.outline.length) return
  fetch('/__api/warm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outline: state.outline }) })
    .then((r) => r.json())
    .then((d) => console.log('[slate] warm', d))
    .catch(() => {})
}

// ---------- 질의응답 흐름 / 问答流程 ----------
// 발표 중 질문: 멈춘 곳 기억 → 듣기 → 답변 → 5초 카운트다운 → 멈춘 구역의 끊긴 문장부터
// 发表中提问：记住暂停处 → 听 → 回答 → 倒计时 5 秒 → 从暂停区域被打断的句子继续
function holdTalk() {
  if (!state.playing) return
  state.resume = { seg: state.seg, sentence: state.sentence }
  pause()
}

function startCountdown(sec = 5) {
  cancelCountdown()
  let n = sec
  const tick = () => {
    if (n <= 0) return resumeTalk()
    avatar.say(LINES.resume(n--))
  }
  tick()
  state.countdown = setInterval(tick, 1000)
}
function cancelCountdown() {
  clearInterval(state.countdown)
  state.countdown = null
}
function resumeTalk() {
  const r = state.resume
  cancelCountdown()
  state.resume = null
  if (!r || !state.script) return
  speaker.cancel()
  playFrom(r.seg, r.sentence)
}
// Esc: 멈춘 채로 (▶ 이어서 로 나중에 계속) / Esc：保持暂停（之后用 ▶ 继续）
function holdStill() {
  const r = state.resume
  cancelCountdown()
  state.resume = null
  if (r) { state.seg = r.seg; state.sentence = r.sentence }
  state.listener?.abort()
  if (state.answer) interruptAnswer('멈춤 / 已停止')
  pause()
  avatar.say('')
}

function afterAnswer(note) {
  setLang('ko-KR') // 질문 하나가 끝나면 「한」으로 / 每个问题结束回到「한」
  avatar.setState('idle')
  if (note && state.resume) toast(note, 8000) // 말풍선은 카운트다운이 씀 / 气泡留给倒计时
  if (state.resume) startCountdown()
  else if (note) avatar.say(note)
  else if (state.script) avatar.say(LINES.more)
  renderProgress()
}

function interruptAnswer(label = '끊고 다시 질문 / 打断重问') {
  const a = state.answer
  if (!a) return
  state.answer = null
  a.interrupted = true
  a.ac.abort()
  speaker.cancel()
  a.el.textContent = `${a.el.textContent === '…' ? '' : a.el.textContent} — (${label})`
}

async function ask(question, { speechEndAt } = {}) {
  question = question.trim()
  if (!question) return
  holdTalk()
  cancelCountdown()
  if (state.answer) interruptAnswer() // 답변 중 새 질문은 버리지 않고 이전 답을 끊음 / 回答中的新问题不丢弃，打断旧回答
  speaker.cancel()
  avatar.setState('thinking')
  avatar.say(`“${question}”`)
  const li = addQa(question, '…')
  const a = { ac: new AbortController(), li, el: li.querySelector('.a'), time: li.querySelector('.t').textContent, speechEndAt, firstVoiceAt: 0 }
  state.answer = a

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
        if (stop) showStop(stop)
      } else if (!/^\s*\[?\[?(g(o(t(o(:[^\]]*\]?)?)?)?)?)?$/.test(raw)) {
        gotoDone = true
      } else if (!final) return
    }
    const text = visible()
    a.el.textContent = text
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

  let refused = false
  try {
    const res = await fetch('/__api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, history: state.qa, outline: state.outline, current }),
      signal: a.ac.signal,
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
        if (ev === 'text' && !refused) { raw += data; feed(false) }
        if (ev === 'refusal') {
          // 말하던 중 체인 전체가 거절: 읽기를 멈추고 남은 문장을 버리고 답을 지움
          // 说到一半整条链拒绝：停读、丢弃剩余句子、清除回答
          refused = true
          queue.length = 0
          speaker.cancel()
          a.el.textContent = '(답변 지움 / 已清除回答)'
        }
        if (ev === 'usage') {
          a.usage = data
          console.log('[slate] answer usage', data)
          renderQaMeta(a)
        }
        if (ev === 'error') throw new Error(data.error)
      }
    }
    if (refused) {
      avatar.say(LINES.refused)
      await speaker.speakOne(LINES.refused)
    } else {
      feed(true)
      // 거절된 질문과 부분 답은 다음 질문의 기록에 넣지 않음 / 被拒的问题与部分回答不进入记录
      state.qa.push({ role: 'user', content: question }, { role: 'assistant', content: visible() })
    }
  } catch (err) {
    if (a.interrupted) return // 끊고 다시 질문: 새 듣기가 이어받음 / 打断重问：由新的聆听接手
    console.warn('[slate] ask', err)
    queue.length = 0
    speaker.cancel()
    a.el.textContent = `⚠ ${err.message}`
    toast(`질문 처리 실패 / 回答失败: ${err.message}`)
    avatar.say(LINES.failed)
    await speaker.speakOne(LINES.failed)
  }
  while (speaking || queue.length) await (speaking || new Promise((r) => setTimeout(r, 100)))
  if (state.answer !== a) return // 그사이 끊겼음 / 期间被打断
  state.answer = null
  afterAnswer()
}

async function micQuestion() {
  if (state.listener) { state.listener.stop(); return } // 듣는 중 Space / ■ = 지금까지 들은 말로 끝 / 听的时候再按 = 用已听到的内容结束
  if (!sttSupported()) {
    toast('이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 으로 열거나 ⌨ 로 입력하세요.\n此浏览器不支持语音识别，请用 Chrome 或 ⌨ 打字。')
    return openTyping()
  }
  holdTalk()
  cancelCountdown() // 카운트다운 중 Space = 추가 질문 (돌아갈 곳은 그대로) / 倒计时中 Space = 追问（返回点不变）
  if (state.answer) interruptAnswer() // 답변 중 Space = 끊고 새로 듣기 / 回答中 Space = 打断并重新听
  speaker.cancel()
  const lang = LANGS.find((l) => l.code === state.lang) ?? LANGS[0]
  avatar.setState('listening')
  avatar.say(lang.listen)
  $('btn-mic').classList.add('is-on')
  $('btn-mic').textContent = '■ 그만 듣기'
  let speechEndAt = 0
  try {
    state.listener = listenOnce({
      lang: lang.code,
      onInterim: (t) => { speechEndAt = performance.now(); avatar.say(t || '…') },
    })
    const text = await state.listener.promise
    state.listener = null
    resetMic()
    if (text) await ask(text, { speechEndAt })
    else afterAnswer(LINES.notHeard) // 아무 말 없음: 알려 주고, 발표 중이었으면 카운트다운 후 이어감 / 没听到：提示，若在发表中则倒计时后继续
  } catch (err) {
    state.listener = null
    resetMic()
    avatar.setState('idle')
    toast(err.message === 'not-allowed'
      ? `마이크가 막혀 있어요. 지금은 ⌨ 로 질문하세요. 허용하려면 일반 Chrome 탭에서 ${location.href} 를 열고 주소창 왼쪽 아이콘에서 마이크를 허용하세요.\n麦克风被阻止。现在请用 ⌨ 打字提问；要允许麦克风，请在普通 Chrome 标签页打开上面的地址，点地址栏左侧图标允许麦克风。`
      : `음성 인식 오류 / 语音识别错误: ${err.message}`, 15000)
    if (err.message === 'not-allowed') openTyping()
    afterAnswer()
  }
}
function resetMic() {
  $('btn-mic').classList.remove('is-on')
  $('btn-mic').textContent = '🎤 질문'
}

function setLang(code) {
  state.lang = code
  const l = LANGS.find((x) => x.code === code) ?? LANGS[0]
  $('btn-lang').textContent = l.label
  $('btn-lang').classList.toggle('is-other', code !== 'ko-KR')
}
function cycleLang() {
  const i = LANGS.findIndex((x) => x.code === state.lang)
  setLang(LANGS[(i + 1) % LANGS.length].code)
}

function openTyping() {
  $('ask-form').hidden = false
  $('ask-input').focus()
}

// ---------- 사이트 점검 / 网站检查 ----------
function runCheck() {
  const s = state.script
  state.check = s ? checkStops(s.stops, state.outline, s.segments.map((g) => g.stop)) : null
  renderCheck()
  if (s) renderScript()
}

function renderCheck() {
  const c = state.check
  const chip = $('site-check')
  if (!c) { chip.hidden = true; return }
  const found = c.total - c.missing
  const problem = !c.ok || state.readStatus !== 'supabase'
  chip.hidden = false
  chip.textContent = problem ? `⚠ 사이트 점검 ${found}/${c.total}` : `사이트 점검 OK · ${found}/${c.total}`
  chip.classList.toggle('is-warn', problem)
  $('status').textContent = `${$('status').dataset.base ?? ''} · ${chip.textContent}`

  const segsOf = (id) => state.script.segments.map((g, i) => (g.stop === id ? `#${i + 1}` : null)).filter(Boolean).join(' ')
  const lead = []
  if (!state.outline.length) lead.push('사이트를 읽지 못했어요. 「사이트 다시 읽기」를 누르거나, 「그대로 발표」를 고르면 화면 이동 없이 음성과 말풍선으로 진행해요. 질의응답은 인터넷이 있을 때만 돼요.\n未能读取网站。可以「重新读取网站」，或选「照常发表」：画面不动，只用语音和气泡；问答需要网络。')
  else if (state.readStatus !== 'supabase' || c.suspectSample) lead.push('내장 샘플 데이터일 수 있어요. 사이트 응답이 늦거나 실패했어요.\n可能是网站内置的示例数据（Supabase 响应慢或失败）。')
  if (c.noSnapshot) lead.push('스냅샷 없음 · 다시 승인하면 생겨요. 지금은 구역 id 로 이동해요.\n无区域快照，重新批准定稿后生成；现在按区域 id 跳转。')
  $('check-lead').textContent = lead.join('\n\n')

  const ul = $('check-list')
  ul.innerHTML = ''
  const item = (cls, text) => {
    const li = document.createElement('li')
    li.className = cls
    li.textContent = text
    ul.appendChild(li)
  }
  if (state.outline.length) {
    for (const r of c.rows.filter((x) => x.status === 'relinked')) item('is-relinked', `다시 연결 / 重新对应: ${r.id} → ${r.to.id} 「${r.to.title}」 (${segsOf(r.id)})`)
    for (const r of c.rows.filter((x) => x.status === 'missing')) item('is-missing', `못 찾음 / 找不到: ${r.id}${r.title ? ` 「${r.title}」` : ''} · 대본 ${segsOf(r.id)} — 화면 이동 없이 읽어요 / 画面不动照读`)
    for (const s of c.added) item('is-added', `새 구역 / 新区域: ${s.id} 「${s.title}」`)
  }
  $('check-list').hidden = !ul.children.length
}

function openCheck() {
  renderCheck()
  $('check').hidden = false
}
const checkHasProblem = () => !state.check || !state.check.ok || state.readStatus !== 'supabase'

async function readSite({ reload = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (reload || attempt > 0) {
      await new Promise((r) => {
        iframe.addEventListener('load', r, { once: true })
        iframe.contentWindow.location.reload()
      })
    }
    hookIframe()
    loaderStep('포트폴리오 사이트를 읽는 중… / 正在读取作品集网站…')
    const r = await reader.extractOutline((tab) => loaderStep(`포트폴리오 사이트를 읽는 중… ${tab}\n正在读取作品集网站… ${tab}`))
    state.outline = r.stops
    state.readStatus = r.status
    console.log(`[slate] site read: ${r.stops.length} stops · ${r.status}`)
    // 실패하면 iframe 을 새로 고쳐 자동으로 한 번 더 / 失败时刷新 iframe 自动再读一次
    if (r.status === 'supabase' || reload || attempt >= 1) break
  }
  if (state.outline.length) {
    fetch('/__api/outline', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stops: state.outline, status: state.readStatus }) }).catch(() => {})
  }
}

// 「사이트 다시 읽기」: 대본은 다시 만들지 않음 / 「重新读取网站」：不重新生成讲稿
async function rereadSite() {
  $('check').hidden = true
  holdStill()
  $('loader').hidden = false
  try {
    await readSite({ reload: true })
    runCheck()
  } finally {
    $('loader').hidden = true
  }
  if (checkHasProblem()) openCheck()
  else toast($('site-check').textContent, 3000)
}

// ---------- 키보드 / 键盘 ----------
function onKey(e) {
  const typing = e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT' || e.target?.tagName === 'TEXTAREA'
  if (typing) {
    if (e.key === 'Escape') { $('ask-form').hidden = true; e.target.blur() }
    return
  }
  if (!$('check').hidden) {
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); $('check').hidden = true }
    return
  }
  if (e.code === 'Space') { e.preventDefault(); micQuestion() }
  else if (e.key === 'p' || e.key === 'P') togglePlay()
  else if (e.key === 'l' || e.key === 'L') cycleLang()
  else if (e.key === 'ArrowRight') jumpTo(state.seg + 1)
  else if (e.key === 'ArrowLeft') jumpTo(state.seg - 1)
  else if (e.key === 'Enter') { e.preventDefault(); openTyping() }
  else if (e.key === 'Escape') holdStill()
}
window.addEventListener('keydown', onKey)

// ---------- 버튼 / 按钮 ----------
$('btn-play').onclick = togglePlay
$('btn-prev').onclick = () => jumpTo(state.seg - 1)
$('btn-next').onclick = () => jumpTo(state.seg + 1)
$('btn-mic').onclick = micQuestion
$('btn-lang').onclick = cycleLang
$('btn-type').onclick = openTyping
$('btn-stop').onclick = holdStill
$('btn-panel').onclick = () => ($('panel').hidden = !$('panel').hidden)
$('btn-close').onclick = () => ($('panel').hidden = true)
$('site-check').onclick = openCheck
$('check-go').onclick = () => ($('check').hidden = true)
$('check-reread').onclick = rereadSite
$('check-review').onclick = () => { $('check').hidden = true; openReview() }
$('btn-review').onclick = () => openReview()
$('ask-form').onsubmit = (e) => {
  e.preventDefault()
  const q = $('ask-input').value
  $('ask-input').value = ''
  $('ask-form').hidden = true
  ask(q) // ⌨ 는 보낼 때 발표를 멈춤 / ⌨ 在发送时才暂停发表
}
document.querySelectorAll('.panel__tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.panel__tabs button').forEach((x) => x.classList.toggle('is-on', x === b))
    document.querySelectorAll('.panel__pane').forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab))
  }
})
function openReview() {
  window.open('/__avatar/review.html', 'slate-review')
}
$('btn-regen').onclick = makeDraft
$('rate').oninput = (e) => {
  speaker.setRate(Number(e.target.value))
  $('rate-out').textContent = e.target.value
  if (state.script) renderScript() // 예상 시간 갱신 / 更新预计时长
}
$('voice').onchange = (e) => speaker.setVoice(e.target.value)
$('key-form').onsubmit = async (e) => {
  e.preventDefault()
  const res = await fetch('/__api/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: $('key-input').value.trim() }) })
  const data = await res.json()
  $('key-input').value = ''
  if (!res.ok) return toast(data.error)
  $('status').dataset.base = 'API OK'
  renderCheck()
  toast('저장했습니다 / 已保存', 3000)
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

// ---------- 대본 / 讲稿 ----------
// 발표는 확정 대본만 읽는다 / 发表只读定稿
async function loadScript() {
  try {
    const res = await fetch('/__api/script')
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    state.script = data
    state.seg = 0
    state.sentence = 0
    renderScript()
  } catch (err) {
    toast(`확정 대본을 불러오지 못했습니다 / 无法加载定稿: ${err.message}`, 15000)
  }
}

// ↻ 새 초안 만들기: 확정 대본은 그대로, 검토 페이지에서 승인해야 바뀜 / 生成新草稿：定稿不变，需在审阅页批准
async function makeDraft() {
  if (!state.outline.length) return toast('사이트를 읽지 못해서 초안을 만들 수 없어요 / 未能读取网站，无法生成草稿')
  if (!confirm('새 대본 초안을 만들까요? (API 사용, 3–4분)\n발표는 검토 페이지에서 승인하기 전까지 지금 확정 대본을 그대로 읽어요.\n\n生成新草稿？（调用 API，约 3–4 分钟）\n在审阅页批准之前，发表仍读现在的定稿。')) return
  holdStill()
  $('loader').hidden = false
  loaderStep('Claude 가 사이트 내용을 각색해 대본 초안을 쓰는 중…\n(11분 분량이라 3–4분 걸립니다) / Claude 正在改编讲稿草稿（约 3–4 分钟）…')
  try {
    const res = await fetch('/__api/script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outline: state.outline, regenerate: true }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    state.script.draft = { createdAt: data.createdAt, source: 'generated' }
    renderScript()
    toast(`초안을 만들었어요 (${data.segments} segments · ${data.chars.toLocaleString()}자). 검토 페이지에서 승인하면 발표에 쓰여요.\n草稿已生成，在审阅页批准后用于发表。`, 10000)
    openReview()
  } catch (err) {
    toast(`초안 생성 실패 / 草稿生成失败: ${err.message}`, 15000)
  } finally {
    $('loader').hidden = true
  }
}

// ---------- 시작 / 启动 ----------
async function boot() {
  const health = await fetch('/__api/health').then((r) => r.json()).catch(() => null)
  $('status').dataset.base = health ? `${health.model}${health.answerModel !== health.model ? ` / 답변 ${health.answerModel}` : ''} · API ${health.hasKey ? 'OK' : '키 없음'}${health.mock ? ' · MOCK' : ''}` : '서버 연결 실패'
  $('status').textContent = $('status').dataset.base
  if (health?.charsPerMinute) state.charsPerMinute = health.charsPerMinute
  if (health?.talkRangeMinutes) state.talkRange = health.talkRangeMinutes
  if (health && !health.hasKey) {
    toast('☰ → 설정에서 Claude API Key 를 넣어 주세요. (대본 발표는 키 없이도 돼요)\n请在 ☰ → 设置 里填入 Claude API Key。（发表讲稿不需要 Key）', 12000)
    openSettings()
  }
  if (/\bEdg\//.test(navigator.userAgent)) {
    toast('Chrome 이 없어 Edge 로 열렸어요. 음성 질문이 불안정할 수 있으니 Chrome 설치를 권해요. ⌨ 글 질문은 그대로 돼요.\n未找到 Chrome，用 Edge 打开；语音提问可能不稳定，建议安装 Chrome。⌨ 打字提问不受影响。', 15000)
  }

  // 사이트를 못 읽는 경우(502 페이지, #root 없음)에도 멈추지 않게 about:blank 만 아니면 진행 / 读不到网站（502 页面）也不卡住
  await new Promise((r) => {
    const d = iframe.contentDocument
    if (d?.readyState === 'complete' && iframe.contentWindow.location.href !== 'about:blank') r()
    else iframe.addEventListener('load', r, { once: true })
  })
  await readSite()
  // 구역이 0개여도 확정 대본은 불러온다 (오프라인 발표 대비) / 区域为 0 也加载定稿（离线发表预案）
  loaderStep('확정 대본 불러오는 중… / 加载定稿…')
  await loadScript()
  runCheck()
  $('loader').hidden = true
  $('dock').hidden = false
  avatar.say(state.script ? '준비됐어요! ▶ 를 누르면 발표를 시작할게요.' : '')
  if (state.script && checkHasProblem()) openCheck()
}

// 서버에 "창이 열려 있음" 알림 (창을 닫으면 서버 종료) / 告诉服务器窗口还开着（关窗后服务器退出）
setInterval(() => fetch('/__api/ping').catch(() => {}), 5000)
fetch('/__api/ping').catch(() => {})

boot()
