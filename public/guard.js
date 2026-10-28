// 사이트 점검: 확정 대본의 구역 스냅샷과 지금 읽은 구역을 비교 (순수 함수, node --test 로 테스트)
// 网站检查：对比定稿的区域快照与当前读取的区域（纯函数，可用 node --test 测试）
//
// 비교 기준은 id 가 아니라 탭 + 제목. id 가 남아 있어도 제목이 다르면 「다른 작품」으로 본다.
// 对比依据是标签 + 标题而不是 id；id 还在但标题不同，视为别的作品。

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * @param snapshot  [{id, tab, title, pos, used}] | null  — 확정 대본의 `stops` / 定稿的 `stops`
 * @param outline   [{id, tab, title, ...}]               — 지금 읽은 구역 / 当前读取的区域
 * @param usedIds   스냅샷이 없을 때 대본이 쓰는 구역 id / 无快照时讲稿用到的区域 id
 * @returns {{
 *   noSnapshot: boolean,
 *   rows: {id, tab, title, status: 'same'|'relinked'|'missing', to: object|null}[],
 *   added: {id, tab, title}[],
 *   links: Record<string, object|null>,
 *   total: number, missing: number, relinked: number,
 *   suspectSample: boolean, ok: boolean,
 * }}
 */
export function checkStops(snapshot, outline = [], usedIds = []) {
  if (!snapshot?.length) {
    // 스냅샷 없음: 지금처럼 id 로 이동 / 无快照：照旧按 id 跳转
    const ids = [...new Set(usedIds)]
    const rows = ids.map((id) => {
      const to = outline.find((s) => s.id === id) ?? null
      return { id, tab: to?.tab ?? null, title: to?.title ?? null, status: to ? 'same' : 'missing', to }
    })
    return summarize({ noSnapshot: true, rows, added: [] }, outline)
  }

  const claimed = new Set()
  const near = (list, pos) => list
    .map((s) => ({ s, d: Math.abs(outline.indexOf(s) - (pos ?? 0)) + (claimed.has(s) ? 1e6 : 0) }))
    .sort((a, b) => a.d - b.d)[0]?.s ?? null

  const rows = []
  for (const snap of snapshot.filter((s) => s.used !== false)) {
    const sameTitle = outline.filter((s) => norm(s.title) === norm(snap.title))
    // 같은 탭에서 먼저, 없으면 다른 탭에서. 여러 개면 원래 순서에 가까운 쪽 / 先同标签，再跨标签；多个取原顺序最近的
    const to = near(sameTitle.filter((s) => norm(s.tab) === norm(snap.tab)), snap.pos) ?? near(sameTitle, snap.pos)
    if (to) claimed.add(to)
    const status = !to ? 'missing' : to.id === snap.id && norm(to.tab) === norm(snap.tab) ? 'same' : 'relinked'
    rows.push({ id: snap.id, tab: snap.tab, title: snap.title, status, to })
  }
  // 대본이 쓰는데 스냅샷에 없는 id (스냅샷이 대본보다 먼저 읽힌 경우): id 로만 연결 / 讲稿用到但快照里没有的 id：只按 id 对应
  for (const id of new Set(usedIds)) {
    if (rows.some((r) => r.id === id)) continue
    const to = outline.find((s) => s.id === id && !claimed.has(s)) ?? null
    if (to) claimed.add(to)
    rows.push({ id, tab: to?.tab ?? null, title: to?.title ?? null, status: to ? 'same' : 'missing', to })
  }

  // 스냅샷 어디에도 없는 구역 = 대본이 쓰인 뒤 생긴 구역 (정보만) / 快照里没有的区域 = 讲稿之后新增的（仅信息）
  const known = new Set(snapshot.map((s) => `${norm(s.tab)}|${norm(s.title)}`))
  const added = outline
    .filter((s) => !claimed.has(s) && !known.has(`${norm(s.tab)}|${norm(s.title)}`))
    .map(({ id, tab, title }) => ({ id, tab, title }))

  return summarize({ noSnapshot: false, rows, added }, outline)
}

function summarize({ noSnapshot, rows, added }, outline) {
  const links = Object.fromEntries(rows.map((r) => [r.id, r.to]))
  const missing = rows.filter((r) => r.status === 'missing').length
  const relinked = rows.filter((r) => r.status === 'relinked').length
  const total = rows.length
  return {
    noSnapshot,
    rows,
    added,
    links,
    total,
    missing,
    relinked,
    // 절반 이상 못 찾으면 내장 샘플 데이터를 읽었을 수 있음 / 一半以上找不到，可能读到了示例数据
    suspectSample: total > 0 && missing * 2 >= total,
    ok: !noSnapshot && outline.length > 0 && missing === 0 && relinked === 0,
  }
}
