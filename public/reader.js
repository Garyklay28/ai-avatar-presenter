// 포트폴리오 사이트 읽기 · 화면 이동
// 读取作品集网站 · 控制页面跳转
//
// iframe 은 같은 출처(로컬 프록시)라서 DOM 을 직접 읽고 탭을 클릭할 수 있다.
// iframe 与 App 同源（本地代理），所以可以直接读 DOM、点击标签页。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeout = 8000) {
  const t0 = performance.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (performance.now() - t0 > timeout) return null
    await sleep(80)
  }
}

const clean = (s) => (s || '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').replace(/[↗→←]/g, '').trim()
const slug = (s) => clean(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 2).join('-')

export function createReader(iframe) {
  const win = () => iframe.contentWindow
  const doc = () => iframe.contentDocument

  function tabButtons() {
    return [...doc().querySelectorAll('.tabs [role=tab]')]
  }
  const tabKey = (btn) => slug(btn.childNodes[0]?.textContent || btn.textContent)

  async function openTab(key) {
    if (!key) return
    const btn = tabButtons().find((b) => tabKey(b) === key)
    if (btn && btn.getAttribute('aria-selected') !== 'true') {
      btn.click()
      await sleep(250)
    }
  }

  function injectStyle() {
    if (doc().getElementById('__avatar-style')) return
    const st = doc().createElement('style')
    st.id = '__avatar-style'
    st.textContent = `
      .__avatar-focus { outline: 4px solid #ffd400 !important; outline-offset: 8px; border-radius: 4px;
        box-shadow: 0 0 0 9999px rgba(13,13,13,.18); transition: outline-color .3s, box-shadow .4s; position: relative; z-index: 5; }
      html { scroll-behavior: smooth; }`
    doc().head.appendChild(st)
  }

  async function readDetail(card) {
    card.click()
    const body = await waitFor(() => doc().querySelector('.detail .detail__body'), 2000)
    const text = body ? clean(body.innerText) : ''
    doc().querySelector('.detail__close')?.click()
    await waitFor(() => !doc().querySelector('.detail'), 1500)
    return text
  }

  /** 사이트 전체를 훑어 구역 목록을 만든다 / 扫描整个网站，生成区域列表 */
  async function extractOutline(onProgress = () => {}) {
    await waitFor(() => doc()?.querySelector('.tabs [role=tab]'), 20000)
    await sleep(1800) // Supabase 콘텐츠가 덮어쓸 시간 / 等 Supabase 内容覆盖
    injectStyle()
    const stops = []
    const add = (s) => stops.push(s)

    for (const btn of tabButtons()) {
      const tab = tabKey(btn)
      onProgress(btn.childNodes[0]?.textContent || tab)
      await openTab(tab)
      await sleep(400)
      const panel = doc().querySelector('.swipe-panel')
      if (!panel) continue

      if (tab === 'profile') {
        const hero = doc().querySelector('.hero')
        if (hero) add({ id: 'hero', tab, title: 'Hero', sel: '.hero', idx: 0, text: clean(hero.innerText) })
        const intro = panel.querySelector('.profile__intro')
        if (intro) add({ id: 'profile-intro', tab, title: 'Profile', sel: '.profile__intro', idx: 0, text: clean(intro.innerText) })
        panel.querySelectorAll('.cols .block').forEach((b, i) => {
          const head = b.querySelector('.block__head')?.innerText || `block ${i + 1}`
          add({ id: `profile-${slug(head) || i}`, tab, title: clean(head), sel: '.cols .block', idx: i, text: clean(b.innerText) })
        })
      } else if (tab === 'film') {
        const cards = [...panel.querySelectorAll('.card')]
        for (const [i, card] of cards.entries()) {
          const title = clean(card.querySelector('.card__title')?.innerText) || `Film ${i + 1}`
          const detail = await readDetail(card)
          add({ id: `film-${String(i + 1).padStart(2, '0')}`, tab, title, sel: '.swipe-panel .card', idx: i, text: detail || clean(card.innerText) })
        }
      } else if (tab === 'images') {
        const groups = [...panel.querySelectorAll('section.project')]
        for (const [i, g] of groups.entries()) {
          const title = clean(g.querySelector('.project__title')?.innerText) || `Group ${i + 1}`
          const parts = [clean(g.querySelector('.project__head')?.innerText)]
          for (const card of g.querySelectorAll('.card')) parts.push(await readDetail(card))
          add({ id: `images-${String(i + 1).padStart(2, '0')}`, tab, title, sel: '.swipe-panel section.project', idx: i, text: parts.filter(Boolean).join('\n') })
        }
      } else {
        const head = panel.querySelector('.sechead')
        if (head) add({ id: `${tab}-head`, tab, title: clean(head.querySelector('h2')?.innerText) || tab, sel: '.swipe-panel .sechead', idx: 0, text: clean(head.innerText) })
        const seen = {}
        panel.querySelectorAll('article.project').forEach((a, i) => {
          const num = clean(a.querySelector('.project__num')?.innerText)
          let id = /^w\d+$/i.test(num) ? num.toLowerCase().replace(/^w(\d)$/, 'w0$1') : num === '+' ? 'extra' : `${tab}-${i + 1}`
          seen[id] = (seen[id] || 0) + 1
          if (seen[id] > 1) id = `${id}-${seen[id]}`
          const files = [...a.querySelectorAll('.asg__file')].map((f) => clean(f.innerText).replace(/\n/g, ' ')).join(' · ')
          const text = clean(a.querySelector('.project__head')?.innerText) + '\n' +
            clean(a.querySelector('.asg__body, .project__body')?.innerText || a.innerText).split('\n').filter((l) => !files.includes(l)).join('\n') +
            (files ? `\n첨부 / 附件: ${files}` : '')
          add({ id, tab, title: clean(a.querySelector('.project__title')?.innerText) || id, sel: '.swipe-panel article.project', idx: i, text })
        })
      }
    }
    const contact = doc().querySelector('#contact')
    if (contact) add({ id: 'contact', tab: null, title: 'Contact', sel: '#contact', idx: 0, text: clean(contact.querySelector('.contact__list')?.innerText || contact.innerText) })

    await openTab(tabKey(tabButtons()[0]))
    win().scrollTo({ top: 0, behavior: 'instant' })
    return stops
  }

  let focused = null

  /** 구역으로 이동하고 강조 / 跳到区域并高亮 */
  async function goto(stop) {
    if (!stop) return null
    injectStyle()
    await openTab(stop.tab)
    const el = await waitFor(() => doc().querySelectorAll(stop.sel)[stop.idx], 3000)
    focused?.classList.remove('__avatar-focus')
    if (!el) return null
    focused = el
    el.classList.add('__avatar-focus')
    const navH = doc().querySelector('.nav')?.offsetHeight ?? 0
    const r = el.getBoundingClientRect()
    const vh = win().innerHeight
    const top = r.height > vh - navH - 80
      ? r.top + win().scrollY - navH - 24
      : r.top + win().scrollY - navH - (vh - navH - r.height) / 2
    win().scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    return el
  }

  function clearFocus() {
    focused?.classList.remove('__avatar-focus')
    focused = null
  }

  /** 강조된 요소의 화면 좌표 (앱 기준) / 高亮元素的屏幕坐标（App 坐标系） */
  function focusRect() {
    if (!focused) return null
    const fr = iframe.getBoundingClientRect()
    const r = focused.getBoundingClientRect()
    const vh = win().innerHeight
    return { top: fr.top + Math.max(80, Math.min(r.top, vh - 200)), right: fr.left + Math.min(r.right, fr.width - 40) }
  }

  return { extractOutline, goto, clearFocus, focusRect, openTab }
}
