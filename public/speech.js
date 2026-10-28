// 음성 출력(TTS) · 음성 인식(STT) — 브라우저 내장 Web Speech API
// 语音合成（TTS）· 语音识别（STT）—— 浏览器自带 Web Speech API

/** 문장 단위로 자르기 (Chrome TTS 는 긴 문장을 중간에 끊는 버그가 있음)
 *  按句切分（Chrome TTS 读长句会中途断掉） */
export function splitSentences(text) {
  const out = []
  for (const raw of text.replace(/\s+/g, ' ').split(/(?<=[.!?。？！…])\s+/)) {
    let s = raw.trim()
    while (s.length > 140) {
      const cut = s.lastIndexOf(',', 140) > 40 ? s.lastIndexOf(',', 140) + 1 : s.lastIndexOf(' ', 140)
      out.push(s.slice(0, cut).trim())
      s = s.slice(cut).trim()
    }
    if (s) out.push(s)
  }
  return out
}

export function createSpeaker({ onStart, onEnd, onBoundary }) {
  const synth = window.speechSynthesis
  let voice = null
  let rate = 1.05
  let token = 0

  function voices() {
    return synth.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('ko'))
  }

  function pickDefault() {
    const list = voices()
    const saved = localStorageGet('voice')
    voice = list.find((v) => v.name === saved) ||
      list.find((v) => /Google/.test(v.name)) ||
      list.find((v) => /Yuna|유나|Premium|Enhanced/i.test(v.name)) ||
      list.find((v) => /SunHi|InJoon|Online/i.test(v.name)) ||
      list[0] || null
    return voice
  }

  /** 한 문장 읽기 → 끝나면 resolve. cancel() 되면 false
   *  读一句，读完 resolve；被 cancel() 时返回 false */
  // 녹화 모드 (?tts=say): 서버의 macOS 음성 파일을 재생하고 시각을 기록 → 녹화 스크립트가 같은 파일로 음성 트랙을 만듦
  // 录屏模式：播放服务器生成的 macOS 语音文件并记录时间 → 录屏脚本用同样的文件合成音轨
  const sayMode = new URLSearchParams(location.search).get('tts') === 'say'
  window.__ttsLog = []
  let audio = null

  function speakSay(text) {
    const my = token
    return new Promise((resolve) => {
      audio = new Audio(`/__api/tts?rate=${rate}&text=${encodeURIComponent(text)}`)
      let done = false
      let tick = null
      const finish = (ok) => { if (done) return; done = true; clearInterval(tick); onEnd?.(); resolve(ok && my === token) }
      audio.onplaying = () => {
        window.__ttsLog.push({ text, t: performance.now() })
        onStart?.(text)
        tick = setInterval(() => onBoundary?.(), 260)
      }
      audio.onended = () => finish(true)
      audio.onerror = () => finish(false)
      audio.onpause = () => { if (!audio.ended) finish(false) }
      audio.play().catch(() => finish(false))
    })
  }

  function speakOne(text) {
    if (sayMode) return speakSay(text)
    const my = token
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'ko-KR'
      if (voice) u.voice = voice
      u.rate = rate
      let done = false
      const finish = (ok) => { if (done) return; done = true; clearInterval(keepAlive); onEnd?.(); resolve(ok && my === token) }
      u.onstart = () => onStart?.(text)
      u.onboundary = () => onBoundary?.()
      u.onend = () => finish(true)
      u.onerror = (e) => finish(e.error !== 'interrupted' && e.error !== 'canceled')
      // Chrome 네트워크 음성이 가끔 멈추는 문제 방지 / 防止 Chrome 在线语音偶尔卡住
      const keepAlive = setInterval(() => { if (!synth.speaking) finish(true) }, 15000)
      synth.speak(u)
    })
  }

  function cancel() {
    token++
    synth.cancel()
    audio?.pause()
  }

  return {
    voices,
    pickDefault,
    get voice() { return voice },
    setVoice(name) { voice = voices().find((v) => v.name === name) || voice; localStorageSet('voice', voice?.name) },
    get rate() { return rate },
    setRate(r) { rate = r },
    speakOne,
    cancel,
    get token() { return token },
  }
}

export function sttSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
}

/** 한 번 듣기: 말이 끝나면 최종 문장을 resolve / 听一次：说完后 resolve 最终文本 */
export function listenOnce({ lang = 'ko-KR', onInterim, silenceMs = 1800 } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  const rec = new SR()
  rec.lang = lang
  rec.interimResults = true
  // 질문 중간에 잠깐 쉬어도 끊기지 않도록 continuous + 직접 만든 침묵 타이머
  // continuous + 自己的静音计时器：提问中间停顿一下也不会被截断
  rec.continuous = true
  rec.maxAlternatives = 1
  let finalText = ''
  let lastText = ''
  let silence = null
  const arm = (ms) => { clearTimeout(silence); silence = setTimeout(() => rec.stop(), ms) }
  const promise = new Promise((resolve, reject) => {
    rec.onresult = (e) => {
      let interim = ''
      finalText = ''
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += r[0].transcript
        else interim += r[0].transcript
      }
      lastText = (finalText + interim).trim()
      onInterim?.(lastText)
      arm(silenceMs)
    }
    rec.onerror = (e) => (e.error === 'no-speech' || e.error === 'aborted' ? resolve(lastText) : reject(new Error(e.error)))
    rec.onend = () => { clearTimeout(silence); resolve(lastText) }
  })
  rec.start()
  arm(9000) // 아무 말도 없으면 9초 후 종료 / 9 秒没说话就结束
  return { promise, stop: () => rec.stop(), abort: () => rec.abort() }
}

function localStorageGet(k) { try { return localStorage.getItem(`avatar.${k}`) } catch { return null } }
function localStorageSet(k, v) { try { localStorage.setItem(`avatar.${k}`, v ?? '') } catch {} }
