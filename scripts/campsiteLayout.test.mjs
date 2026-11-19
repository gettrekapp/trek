// scripts/campsiteLayout.test.mjs — where everyone stands at the campsite: tents out from the fire
// (right, left, …), Global on a log, waiting hikers at the fire, grouped mode when it is crowded.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SPREAD, campLayout, popoverLeft, signText, tentBadge } from '../plugins/campsite/shared/layout.ts'

let n = 0
const s = (worktreeId, over = {}) => ({ terminalId: `t${++n}`, label: 'Claude', provider: 'claude', status: 'working', decision: false, worktreeId, worktreeName: worktreeId, branch: worktreeId && `b/${worktreeId}`, ...over })

test('one worktree: its tent right of the fire, its hikers in front of it', () => {
  const sessions = [s('w1'), s('w1')]
  const l = campLayout(sessions, 1000)
  assert.equal(l.fireX, 500)
  assert.equal(l.grouped, false)
  assert.equal(l.tents.length, 1)
  assert.ok(l.tents[0].x > 500)
  assert.deepEqual(l.hikers.map((h) => h.place), ['tent', 'tent'])
  for (const h of l.hikers) assert.ok(Math.abs(h.x - l.tents[0].x) <= 60)
})

test('tents alternate right, left, right; Global takes the log, left of the fire, first', () => {
  const l = campLayout([s('w1'), s('w2'), s('w3'), s(null)], 1400)
  const [t1, t2, t3] = l.tents
  assert.deepEqual(l.tents.map((t) => t.worktreeId), ['w1', 'w2', 'w3'])
  assert.ok(l.log && l.log.x < l.fireX)
  assert.ok(t1.x > l.fireX && t3.x > t1.x, 'w1 then w3 to the right')
  assert.ok(t2.x < l.log.x, 'w2 left, beyond the log')
  assert.equal(l.hikers.find((h) => h.place === 'log')?.x, l.log.x)
})

test('waiting hikers (attention or a decision) stand at the fire; exited ones are inside their tent', () => {
  const waving = s('w1', { status: 'attention' })
  const deciding = s('w1', { decision: true })
  const gone = s('w1', { status: 'exited' })
  const l = campLayout([s('w1'), waving, deciding, gone], 1000)
  const at = (id) => l.hikers.find((h) => h.terminalId === id)
  assert.equal(at(waving.terminalId).place, 'fire')
  assert.equal(at(deciding.terminalId).place, 'fire')
  assert.ok(Math.abs(at(waving.terminalId).x - 500) < 120)
  assert.notEqual(at(waving.terminalId).x, at(deciding.terminalId).x)
  assert.equal(at(gone.terminalId).place, 'inside')
  assert.equal(at(gone.terminalId).x, l.tents[0].x)
  assert.deepEqual([l.tents[0].hikers, l.tents[0].waiting], [4, 2])
})

test(`grouped above ${MAX_SPREAD} hikers out: only waiting hikers are drawn, tents carry counts`, () => {
  // MAX_SPREAD + 1 out (waiting ones don't count), plus one waving
  const many = Array.from({ length: MAX_SPREAD + 2 }, (_, i) => s(`w${i % 3}`))
  many[0] = { ...many[0], status: 'attention' }
  const l = campLayout(many, 2000)
  assert.equal(l.grouped, true)
  assert.deepEqual(l.hikers.map((h) => h.place), ['fire'])
  assert.equal(l.tents.reduce((sum, t) => sum + t.hikers, 0), MAX_SPREAD + 2)
  assert.equal(campLayout(many.slice(1), 2000).grouped, true, `${MAX_SPREAD + 1} out`)
  assert.equal(campLayout(many.slice(2), 4000).grouped, false, `${MAX_SPREAD} out, room to spare`)
})

test('grouped when the tents and hikers do not fit the width; tents that still do not fit are counted', () => {
  // 360px: the fire leaves 224–336 on the right and 24–136 on the left; three hikers need 120px
  const narrow = campLayout([s('a'), s('a'), s('a'), s('b'), s('b'), s('b')], 360)
  assert.equal(narrow.grouped, true)
  const crowded = campLayout(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((w) => s(w)), 360)
  assert.ok(crowded.moreTents > 0)
  assert.equal(crowded.tents.length + crowded.moreTents, 8)
})

test('everything drawn is inside the strip', () => {
  for (const width of [360, 800, 1600]) {
    const l = campLayout(['a', 'b', 'c'].flatMap((w) => [s(w), s(w, { status: 'attention' })]).concat([s(null)]), width)
    for (const h of l.hikers) assert.ok(h.x >= 0 && h.x <= width, `${width}: hiker at ${h.x}`)
    for (const t of l.tents) assert.ok(t.x >= 0 && t.x <= width, `${width}: tent at ${t.x}`)
  }
})

test('tentBadge and signText', () => {
  assert.equal(tentBadge({ hikers: 3, waiting: 0 }), '3')
  assert.equal(tentBadge({ hikers: 3, waiting: 1 }), '3 · 1 waving')
  assert.equal(signText('feature/a-very-long-branch-name'), 'a-very-long-b…')
  assert.equal(signText('main'), 'main')
  assert.equal(signText('averyveryverylongbranchname'), 'averyveryvery…')
})

test('no sessions: just the fire', () => {
  const l = campLayout([], 800)
  assert.deepEqual([l.tents, l.hikers, l.log, l.grouped], [[], [], null, false])
})

test('waiting hikers are placed inside the strip; those past the room are counted', () => {
  for (const width of [360, 400, 900]) {
    const waiting = Array.from({ length: 10 }, () => s('w1', { status: 'attention' }))
    const l = campLayout(waiting, width)
    const placed = l.hikers.filter((h) => h.place === 'fire')
    for (const h of placed) assert.ok(h.x >= 0 && h.x <= width, `${width}: hiker at ${h.x}`)
    assert.equal(placed.length + l.moreWaiting, 10)
  }
  assert.equal(campLayout([s('w1', { status: 'attention' })], 800).moreWaiting, 0)
})

test('a Global log left out is counted in moreTents', () => {
  const sessions = [...Array.from({ length: 6 }, () => s('w1', { status: 'attention' })), s(null), s(null), s('w2'), s('w3')]
  const l = campLayout(sessions, 400)
  assert.equal(l.log, null)
  assert.equal(l.tents.length + l.moreTents + (l.log ? 1 : 0), 4)
})

test('width 0 or less (not measured yet): an empty layout', () => {
  for (const w of [0, -5]) {
    assert.deepEqual(campLayout([s('w1'), s(null)], w), { width: w, fireX: 0, grouped: false, tents: [], log: null, hikers: [], moreTents: 0, moreWaiting: 0 })
  }
})

test('popoverLeft: at its badge, kept 8 px inside the window', () => {
  assert.equal(popoverLeft(300, 200, 1000), 300)
  assert.equal(popoverLeft(900, 200, 1000), 792)
  assert.equal(popoverLeft(2, 200, 1000), 8)
  assert.equal(popoverLeft(50, 400, 300), 8, 'a window narrower than the popover: its left edge')
})

test('the Global log counts its hikers and those waving, for its badge in grouped mode', () => {
  const crowd = Array.from({ length: 14 }, (_, i) => s(`w${i % 2}`))
  const global = [s(null), s(null), s(null, { status: 'attention' }), s(null, { decision: true })]
  const l = campLayout([...crowd, ...global], 1200)
  assert.equal(l.grouped, true)
  assert.ok(l.log)
  assert.equal(l.log.hikers, 4)
  assert.equal(l.log.waiting, 2)
  assert.equal(tentBadge(l.log), '4 · 2 waving')
  const open = campLayout([s('w1'), s(null)], 1200)
  assert.equal(open.grouped, false)
  assert.deepEqual({ hikers: open.log.hikers, waiting: open.log.waiting }, { hikers: 1, waiting: 0 })
})
