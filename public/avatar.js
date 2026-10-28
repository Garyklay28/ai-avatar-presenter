// 슬레이트 — 마우스를 따라다니는 클래퍼보드 캐릭터
// 슬레이트（场记板）—— 跟着鼠标走的场记板角色
//
// 상태 / 状态: idle · speaking(클래퍼가 입처럼 열림 / 拍板像嘴一样开合) · listening · thinking

const SVG = `
<svg class="slate" viewBox="0 0 160 170" aria-hidden="true">
  <ellipse class="slate__shadow" cx="80" cy="162" rx="46" ry="7"/>
  <g class="slate__legs">
    <path class="slate__leg slate__leg--l" d="M60 138 L56 156 L46 157"/>
    <path class="slate__leg slate__leg--r" d="M100 138 L104 156 L114 157"/>
  </g>
  <g class="slate__body">
    <rect x="18" y="58" width="124" height="84" rx="10" fill="#0d0d0d"/>
    <rect x="18" y="44" width="124" height="16" rx="3" fill="#ffffff" stroke="#0d0d0d" stroke-width="3"/>
    <g clip-path="url(#slate-lower)">
      <path d="M22 44 l14 16 h12 l-14 -16 z M50 44 l14 16 h12 l-14 -16 z M78 44 l14 16 h12 l-14 -16 z M106 44 l14 16 h12 l-14 -16 z" fill="#0d0d0d"/>
    </g>
    <g class="slate__eyes">
      <ellipse cx="58" cy="92" rx="13" ry="15" fill="#ffffff"/>
      <ellipse cx="102" cy="92" rx="13" ry="15" fill="#ffffff"/>
      <circle class="slate__pupil" cx="58" cy="94" r="6" fill="#0d0d0d"/>
      <circle class="slate__pupil" cx="102" cy="94" r="6" fill="#0d0d0d"/>
      <rect class="slate__lid" x="43" y="76" width="74" height="0" fill="#0d0d0d"/>
    </g>
    <ellipse cx="40" cy="114" rx="7" ry="4" fill="#ffd400" opacity=".85"/>
    <ellipse cx="120" cy="114" rx="7" ry="4" fill="#ffd400" opacity=".85"/>
    <path class="slate__smile" d="M70 116 Q80 124 90 116" stroke="#ffffff" stroke-width="3" fill="none" stroke-linecap="round"/>
    <text x="80" y="136" text-anchor="middle" class="slate__label">TAKE 1</text>
  </g>
  <g class="slate__clapper">
    <rect x="18" y="26" width="124" height="16" rx="3" fill="#ffffff" stroke="#0d0d0d" stroke-width="3"/>
    <g clip-path="url(#slate-upper)">
      <path d="M22 26 l14 16 h12 l-14 -16 z M50 26 l14 16 h12 l-14 -16 z M78 26 l14 16 h12 l-14 -16 z M106 26 l14 16 h12 l-14 -16 z" fill="#0057d4"/>
    </g>
  </g>
  <circle class="slate__hinge" cx="22" cy="42" r="4" fill="#ffd400" stroke="#0d0d0d" stroke-width="2"/>
  <defs>
    <clipPath id="slate-lower"><rect x="20" y="46" width="120" height="12"/></clipPath>
    <clipPath id="slate-upper"><rect x="20" y="28" width="120" height="12"/></clipPath>
  </defs>
</svg>`

export function createAvatar(root) {
  root.innerHTML = `
    <div class="avatar__bubble" hidden><span class="avatar__text"></span></div>
    <div class="avatar__badge" hidden></div>
    <div class="avatar__figure">${SVG}</div>`
  const bubble = root.querySelector('.avatar__bubble')
  const bubbleText = root.querySelector('.avatar__text')
  const badge = root.querySelector('.avatar__badge')
  const figure = root.querySelector('.avatar__figure')
  const clapper = root.querySelector('.slate__clapper')
  const pupils = [...root.querySelectorAll('.slate__pupil')]
  const lid = root.querySelector('.slate__lid')

  const pos = { x: window.innerWidth - 220, y: window.innerHeight - 260 }
  const target = { ...pos }
  let facing = 1
  let mouth = 0 // 0..1
  let speaking = false
  let blink = 0
  let nextBlink = performance.now() + 2500
  let anchor = null // 발표 중 마우스가 멈추면 가리킬 위치 / 演示时鼠标不动就指向这里
  let lastMouse = 0

  const W = 150, H = 160

  function follow(clientX, clientY) {
    lastMouse = performance.now()
    // 커서 오른쪽 아래에 서서 따라옴 / 站在光标右下方跟随
    target.x = clientX + 28
    target.y = clientY + 18
  }

  function setAnchor(rect) { anchor = rect }

  function setState(state) {
    root.dataset.state = state
    speaking = state === 'speaking'
    badge.hidden = !(state === 'listening' || state === 'thinking')
    badge.textContent = state === 'listening' ? '듣는 중… / 正在听' : state === 'thinking' ? '생각 중… / 思考中' : ''
  }

  function say(text) {
    if (!text) { bubble.hidden = true; return }
    bubbleText.textContent = text
    bubble.hidden = false
  }

  function pulse() { mouth = Math.min(1, mouth + 0.6) } // 단어 경계에서 입을 크게 / 词边界时嘴张大

  function frame(now) {
    // 마우스가 4초 이상 멈춰 있고 가리킬 곳이 있으면 그쪽으로 걸어감
    // 鼠标静止 4 秒以上且有指向目标时，走到那里
    if (anchor && now - lastMouse > 4000) {
      const ax = Math.min(window.innerWidth - W - 12, Math.max(12, anchor.right - W * 0.4))
      const ay = Math.min(window.innerHeight - H - 90, Math.max(110, anchor.top + 10))
      target.x = ax; target.y = ay
    }
    const tx = Math.min(window.innerWidth - W - 8, Math.max(8, target.x))
    const ty = Math.min(window.innerHeight - H - 8, Math.max(8, target.y))
    const dx = tx - pos.x, dy = ty - pos.y
    pos.x += dx * 0.09
    pos.y += dy * 0.09
    const moving = Math.hypot(dx, dy) > 3
    if (Math.abs(dx) > 4) facing = dx > 0 ? 1 : -1
    root.style.transform = `translate(${pos.x}px, ${pos.y}px)`
    figure.style.transform = `scaleX(${facing})`
    root.classList.toggle('is-walking', moving)

    // 입(클래퍼) / 嘴（拍板）
    if (speaking) mouth += ((0.35 + 0.65 * Math.abs(Math.sin(now / 90) * Math.sin(now / 37))) - mouth) * 0.35
    else mouth += (0 - mouth) * 0.25
    clapper.setAttribute('transform', `rotate(${-mouth * 24} 22 42)`)

    // 눈은 진행 방향을 봄 / 眼睛看向前进方向
    const lx = Math.max(-4, Math.min(4, dx / 25)) * facing
    const ly = Math.max(-3, Math.min(4, dy / 25))
    pupils.forEach((p, i) => { p.setAttribute('cx', (i ? 102 : 58) + lx); p.setAttribute('cy', 94 + ly) })

    if (now > nextBlink) { blink = 1; nextBlink = now + 2500 + Math.random() * 3000 }
    blink = Math.max(0, blink - 0.12)
    lid.setAttribute('height', String(Math.sin(blink * Math.PI) * 32))

    // 말풍선은 화면 밖으로 나가지 않게 / 气泡不超出屏幕
    const bw = bubble.offsetWidth
    const left = Math.min(Math.max(-pos.x + 8, W / 2 - bw / 2), window.innerWidth - pos.x - bw - 8)
    bubble.style.left = `${left}px`
    bubble.classList.toggle('is-below', pos.y < bubble.offsetHeight + 24)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  setState('idle')

  return { follow, setState, say, pulse, setAnchor }
}
