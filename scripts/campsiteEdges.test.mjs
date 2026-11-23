// scripts/campsiteEdges.test.mjs — the camp's buildings on the strip (campsite part 3a): their pixel
// art, the fire ring's tiers, the string lights, where buildings stand at the two ends, and the
// middle that campLayout gets.
import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILDING_SCALE, BUILDING_SIZE, LIGHTS_SAG, LIGHTS_Y, artBottom, buildingArt, bulbAlpha, fireRing, iconArt, lightString } from '../plugins/campsite/shared/buildingPixels.ts'
import { CATALOG } from '../plugins/campsite/shared/catalog.ts'
import { MIDDLE_MIN, placeBuildings } from '../plugins/campsite/shared/campEdges.ts'
import { TENT_W, campLayout } from '../plugins/campsite/shared/layout.ts'

const onGrid = (art) => art.rects.every((r) => r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= art.w && r.y + r.h <= art.h && /^#[0-9a-f]{6}$/.test(r.fill))

test('building art: cabins 46×34, the lake 90×10 (its dock at tier 2), the garden 26×14 (plot, then beds); every rect on its grid', () => {
  assert.deepEqual(BUILDING_SIZE, { cabins: { w: 46, h: 34 }, lake: { w: 90, h: 10 }, garden: { w: 26, h: 14 } })
  for (const [id, tier] of [['cabins', 1], ['cabins', 3], ['lake', 1], ['lake', 2], ['garden', 1], ['garden', 2]]) {
    const art = buildingArt(id, tier)
    assert.deepEqual([art.w, art.h], [BUILDING_SIZE[id].w, BUILDING_SIZE[id].h], `${id} ${tier}`)
    assert.ok(onGrid(art), `${id} ${tier} stays on its grid`)
  }
  assert.ok(buildingArt('lake', 2).rects.length > buildingArt('lake', 1).rects.length, 'the dock adds planks')
  assert.notDeepEqual(buildingArt('garden', 2).rects, buildingArt('garden', 1).rects)
  assert.equal(BUILDING_SCALE, 2)
  assert.equal(artBottom('cabins'), 100)
  assert.equal(artBottom('garden'), 100)
  assert.equal(artBottom('lake'), 112)
})

test('icons: one for every building and tier, on their grids', () => {
  for (const b of CATALOG) {
    for (let tier = 1; tier <= b.tiers.length; tier++) {
      const art = iconArt(b.id, tier)
      assert.ok(onGrid(art), `${b.id} ${tier}`)
      assert.ok(art.w <= 46 && art.h <= 34)
    }
  }
  assert.notDeepEqual(iconArt('fire', 3).rects, iconArt('fire', 1).rects)
})

test("fire ring: nothing extra at tier 1, a ring around today's hearth at 2, a wider one at 3", () => {
  assert.deepEqual(fireRing(500, 1), [])
  const two = fireRing(500, 2)
  const three = fireRing(500, 3)
  assert.ok(two.length > 0 && three.length > two.length)
  const span = (bs) => [Math.min(...bs.map((b) => b.x)), Math.max(...bs.map((b) => b.x + b.w))]
  assert.ok(span(three)[0] < span(two)[0] && span(three)[1] > span(two)[1])
  assert.ok(span(two)[0] < 500 - 23 && span(two)[1] > 500 + 23, "outside today's 46 px hearth")
  assert.deepEqual(fireRing(600, 2).map((b) => b.x - 100), two.map((b) => b.x), 'it moves with the fire')
})

test('string lights: a sagging wire between the ends, bulbs on it, twinkling in steps', () => {
  const s = lightString(100, 700)
  assert.ok(s.wire.length > 0 && s.bulbs.length > 0)
  for (const b of [...s.wire, ...s.bulbs]) {
    assert.ok(b.x >= 100 && b.x + b.w <= 702, `x ${b.x}`)
    assert.ok(b.y >= LIGHTS_Y && b.y + b.h <= LIGHTS_Y + LIGHTS_SAG + 3, `y ${b.y}`)
  }
  assert.ok(s.wire.some((b) => b.y > LIGHTS_Y), 'it sags')
  assert.ok(s.wire.some((b) => b.y === LIGHTS_Y), 'between anchors')
  assert.deepEqual(lightString(100, 700), s)
  assert.deepEqual(lightString(300, 300), { wire: [], bulbs: [] })
  for (const t of [0, 400, 800, 1200, 1600]) assert.ok([1, 0.75, 0.45].includes(bulbAlpha(0, t)))
  assert.notEqual(bulbAlpha(0, 0), bulbAlpha(1, 0), 'neighbours out of step')
})

const built = (o = {}) => ({ lights: 0, fire: 1, garden: 0, lake: 0, cabins: 0, ...o })
const ALL = built({ lights: 1, fire: 3, garden: 2, lake: 2, cabins: 3 })
const NONE = { left: [], right: [], reserve: { left: 0, right: 0 } }

test('placeBuildings: nothing at the ends, nothing placed, no reserve (the lights and the fire ring are not placed)', () => {
  assert.deepEqual(placeBuildings(built({ lights: 1, fire: 3 }), 1200), NONE)
  assert.deepEqual(placeBuildings(ALL, 0), NONE)
})

test('placeBuildings: cabins side by side from the left edge; the lake against the right edge, the garden inside it', () => {
  const e = placeBuildings(ALL, 1600)
  assert.deepEqual(e.left.map((p) => p.key), ['cabin1', 'cabin2', 'cabin3'])
  assert.deepEqual(e.left.map((p) => p.x), [8, 108, 208])
  assert.deepEqual(e.left.map((p) => [p.w, p.h, p.bottom]), [[92, 68, 100], [92, 68, 100], [92, 68, 100]])
  assert.deepEqual(e.right.map((p) => p.id), ['lake', 'garden'])
  assert.equal(e.right[0].x + e.right[0].w, 1600 - 8, 'the lake against the right edge')
  assert.equal(e.right[1].x + e.right[1].w, e.right[0].x - 8)
  assert.deepEqual(e.reserve, { left: 8 + 3 * 92 + 2 * 8 + 16, right: 8 + 180 + 8 + 52 + 16 })
  for (const p of [...e.left, ...e.right]) assert.equal(p.tier, ALL[p.id])
})

test('placeBuildings: each end within a quarter of the width, the outermost dropped first; the middle keeps its minimum', () => {
  const e = placeBuildings(ALL, 1200)
  assert.deepEqual(e.left.map((p) => p.key), ['cabin2', 'cabin3'], 'three cabins need 316 px of 300: the outermost goes')
  assert.deepEqual(e.left.map((p) => p.x), [8, 108])
  assert.deepEqual(e.right.map((p) => p.id), ['lake', 'garden'])
  const narrow = placeBuildings(ALL, 700)
  assert.deepEqual(narrow.left.map((p) => p.x), [8])
  assert.deepEqual(narrow.right.map((p) => p.id), ['garden'], 'the lake is outermost: dropped first')
  assert.equal(narrow.right[0].x + narrow.right[0].w, 700 - 8)
  assert.deepEqual(placeBuildings(ALL, 600).left, [], 'the middle needs its 480 px: the wider end gives way')
  for (const w of [300, 500, 600, 700, 900, 1200, 1600, 2400]) {
    const x = placeBuildings(ALL, w)
    assert.ok(x.reserve.left <= w / 4 && x.reserve.right <= w / 4, `${w}: each end within a quarter`)
    assert.ok(w - x.reserve.left - x.reserve.right >= Math.min(w, MIDDLE_MIN), `${w}: the middle keeps ${MIDDLE_MIN}`)
  }
})

let n = 0
const s = (worktreeId, over = {}) => ({ terminalId: `e${++n}`, label: 'Claude', provider: 'claude', status: 'working', decision: false, worktreeId, worktreeName: worktreeId, branch: worktreeId && `b/${worktreeId}`, ...over })

test('campLayout with a reserve: the fire in the middle region, every tent, the log and every hiker inside it', () => {
  const sessions = [s('w1'), s('w1'), s('w2'), s('w3'), s(null), s('w4', { status: 'attention' })]
  const l = campLayout(sessions, 1200, { left: 300, right: 100 })
  assert.equal(l.fireX, 700)
  assert.equal(l.width, 1200)
  assert.equal(l.grouped, false)
  for (const t of l.tents) assert.ok(t.x - TENT_W / 2 >= 300 + 24 && t.x + TENT_W / 2 <= 1100 - 24, `tent at ${t.x}`)
  assert.ok(l.log && l.log.x - 36 >= 300 + 24, 'the log')
  for (const h of l.hikers) assert.ok(h.x - 18 >= 300 && h.x + 18 <= 1100, `hiker at ${h.x}`)
  assert.deepEqual(campLayout(sessions, 1200, { left: 0, right: 0 }), campLayout(sessions, 1200), 'no reserve: as before')
})
