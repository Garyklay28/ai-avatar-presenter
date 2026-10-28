// node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkStops } from '../public/guard.js'

const site = [
  { id: 'hero', tab: 'profile', title: 'Hero' },
  { id: 'film-01', tab: 'film', title: 'The Little Postman with a Gun' },
  { id: 'film-02', tab: 'film', title: 'Dusk' },
  { id: 'w07', tab: 'projects', title: '자막 번역 스킬' },
]
const snap = (outline, used = outline.map((s) => s.id)) =>
  outline.map((s, pos) => ({ id: s.id, tab: s.tab, title: s.title, pos, used: used.includes(s.id) }))

test('같은 사이트면 모두 같음 / 相同网站全部相同', () => {
  const r = checkStops(snap(site), site)
  assert.equal(r.ok, true)
  assert.deepEqual(r.rows.map((x) => x.status), ['same', 'same', 'same', 'same'])
  assert.equal(r.links['film-02'].id, 'film-02')
  assert.deepEqual(r.added, [])
})

test('작품 순서가 바뀌면 제목으로 다시 연결 / 顺序变化按标题重新对应', () => {
  const now = [site[0], { ...site[2], id: 'film-01' }, { ...site[1], id: 'film-02' }, site[3]]
  const r = checkStops(snap(site), now)
  assert.equal(r.ok, false)
  assert.equal(r.relinked, 2)
  assert.equal(r.links['film-01'].title, 'The Little Postman with a Gun')
  assert.equal(r.links['film-01'].id, 'film-02')
})

test('없어진 구역은 못 찾음, 새 구역은 정보만 / 删除的找不到，新增的仅信息', () => {
  const now = [site[0], site[1], site[3], { id: 'w10', tab: 'projects', title: 'W10' }]
  const r = checkStops(snap(site), now)
  assert.equal(r.missing, 1)
  assert.equal(r.links['film-02'], null)
  assert.deepEqual(r.added.map((s) => s.id), ['w10'])
  assert.equal(r.suspectSample, false)
})

test('탭 이름이 바뀌어도 제목으로 찾음 / 标签改名也按标题找到', () => {
  const now = site.map((s) => (s.tab === 'film' ? { ...s, tab: 'films' } : s))
  const r = checkStops(snap(site), now)
  assert.equal(r.missing, 0)
  assert.equal(r.relinked, 2)
})

test('절반 이상 못 찾으면 샘플 의심, 구역 0개도 처리 / 一半以上找不到提示示例数据，0 个区域也能处理', () => {
  const r = checkStops(snap(site), [site[0]])
  assert.equal(r.suspectSample, true)
  const empty = checkStops(snap(site), [])
  assert.equal(empty.missing, 4)
  assert.equal(empty.ok, false)
})

test('대본이 안 쓰는 구역은 비교하지 않음 / 讲稿不用的区域不比较', () => {
  const r = checkStops(snap(site, ['hero', 'w07']), [site[0], site[3]])
  assert.equal(r.ok, true)
  assert.equal(r.total, 2)
})

test('스냅샷 없으면 id 로 연결 / 无快照按 id 对应', () => {
  const r = checkStops(null, site, ['hero', 'film-02', 'gone'])
  assert.equal(r.noSnapshot, true)
  assert.equal(r.ok, false)
  assert.equal(r.links['film-02'].id, 'film-02')
  assert.equal(r.links.gone, null)
})

test('스냅샷에 없는 대본 구역은 id 로 연결 / 快照里没有的讲稿区域按 id 对应', () => {
  const r = checkStops(snap(site.slice(0, 3)), site, ['hero', 'w07'])
  assert.equal(r.links.w07.id, 'w07')
  assert.equal(r.missing, 0)
})
