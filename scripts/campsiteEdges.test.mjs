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
  assert.deepEqual(BUILDING_SIZE, { cabins: { w: 46, h: 34 }, lake: { w: 90, h: 10 }, garden: { w: 26, h: 14 }, shed: { w: 30, h: 26 } })
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

test("string lights: the wire's last piece stops at the right end", () => {
  for (const [l, r] of [[100, 700], [100, 701], [101, 700], [37.5, 812.25]]) {
    const { wire } = lightString(l, r)
    const last = wire[wire.length - 1]
    assert.ok(last.x + last.w <= r, `${l}–${r}: ends at ${last.x + last.w}`)
    assert.ok(last.w > 0)
    for (const b of wire) assert.ok(b.x >= l && b.x + b.w <= r)
  }
})

test('placeBuildings at the thresholds: the middle keeps MIDDLE_MIN; each end keeps to a quarter', () => {
  const one = built({ cabins: 1 })
  // One cabin keeps 8 + 92 + 16 = 116 px: placed while 480 px are left between
  assert.equal(placeBuildings(one, 116 + MIDDLE_MIN).left.length, 1)
  assert.equal(placeBuildings(one, 116 + MIDDLE_MIN - 1).left.length, 0)
  // Three cabins keep 16 + 300 = 316 px: all three from 4 × 316 wide, two below it
  const three = built({ cabins: 3 })
  assert.equal(placeBuildings(three, 4 * 316).left.length, 3)
  assert.deepEqual(placeBuildings(three, 4 * 316 - 1).left.map((p) => p.key), ['cabin2', 'cabin3'])
  // The lake and the garden keep 8 + 180 + 8 + 52 + 16 = 264 px
  const water = built({ lake: 2, garden: 2 })
  assert.equal(placeBuildings(water, 4 * 264).right.length, 2)
  assert.deepEqual(placeBuildings(water, 4 * 264 - 1).right.map((p) => p.id), ['garden'])
  // Too narrow a middle for both ends: the end keeping more gives way, outermost first. Two cabins
  // keep 216 px, the lake 204: both while 480 px are left between (900 wide), a cabin fewer below
  const pair = built({ cabins: 2, lake: 1 })
  const at = (w) => placeBuildings(pair, w)
  assert.deepEqual([at(900).left.length, at(900).right.length], [2, 1])
  assert.deepEqual(at(899).left.map((p) => p.key), ['cabin2'], 'the left (216 > 204) drops its outermost cabin')
  assert.equal(at(899).right.length, 1)
  // (A tie, both ends keeping the same px, drops from the left; no two ends' sizes tie today)
})

test('placeBuildings: a sweep of widths keeps every building inside the strip, none overlapping', () => {
  for (const b of [ALL, built({ cabins: 2, garden: 1 }), built({ lake: 1 }), built({ cabins: 1, lake: 2 })]) {
    for (let w = 0; w <= 2600; w += 7) {
      const e = placeBuildings(b, w)
      const all = [...e.left, ...e.right].sort((x, y) => x.x - y.x)
      for (const p of all) assert.ok(p.x >= 0 && p.x + p.w <= w, `${w}: ${p.key} at ${p.x}`)
      for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].x + all[i - 1].w <= all[i].x, `${w}: ${all[i - 1].key} overlaps ${all[i].key}`)
      assert.ok(e.reserve.left + e.reserve.right <= w)
    }
  }
})

// The harness's "few" camp: two worktrees (api, web), two Global sessions on the log
const FEW = [
  s('api', { status: 'working' }),
  s('api', { status: 'attention' }),
  s('web', { status: 'done' }),
  s(null, { status: 'idle' }),
  s('web', { status: 'complete' }),
  s(null, { status: 'working', decision: true })
]

test('camps beat buildings: a building that would hide a camp (or group them) is dropped instead', () => {
  const bare = campLayout(FEW, 700)
  assert.equal(bare.moreTents, 0)
  assert.equal(bare.grouped, false)
  const e = placeBuildings(ALL, 700, FEW)
  const l = campLayout(FEW, 700, e.reserve)
  assert.equal(l.moreTents, 0, 'no camp hidden')
  assert.equal(l.grouped, false)
  assert.equal(l.moreWaiting, 0)
  assert.ok(e.left.length + e.right.length < placeBuildings(ALL, 700).left.length + placeBuildings(ALL, 700).right.length, 'buildings were dropped')
  // Wide enough for both: as many as with nobody at camp
  assert.deepEqual(placeBuildings(ALL, 1600, FEW), placeBuildings(ALL, 1600))
  // Crowded already: buildings never hide more than the bare strip does
  const crowd = Array.from({ length: 20 }, (_, i) => s(`wt${i % 6}`, { status: i % 5 === 0 ? 'attention' : 'working' }))
  for (const w of [700, 1000, 1200, 1600, 2400]) {
    const before = campLayout(crowd, w)
    const after = campLayout(crowd, w, placeBuildings(ALL, w, crowd).reserve)
    assert.ok(after.moreTents <= before.moreTents && after.moreWaiting <= before.moreWaiting && (!after.grouped || before.grouped), `${w}`)
  }
})

test('the gear shed (campsite part 3b): 30×26 on its grid, more at tier 2, standing on the tents\' line', () => {
  for (const tier of [1, 2]) {
    const art = buildingArt('shed', tier)
    assert.deepEqual([art.w, art.h], [30, 26])
    assert.ok(onGrid(art), `shed ${tier} stays on its grid`)
    assert.ok(onGrid(iconArt('shed', tier)))
  }
  assert.ok(buildingArt('shed', 2).rects.length > buildingArt('shed', 1).rects.length, 'tier 2 adds the sign, lantern, axe and skis')
  assert.equal(artBottom('shed'), 100)
})

const SHED = built({ lights: 1, fire: 3, garden: 2, lake: 2, cabins: 3, shed: 2 })

test('placeBuildings: the shed stands inside the cabins at the left end, and is the first building dropped there', () => {
  const wide = placeBuildings(SHED, 1600)
  assert.deepEqual(wide.left.map((p) => p.key), ['cabin1', 'cabin2', 'cabin3', 'shed'])
  assert.deepEqual(wide.left.map((p) => p.x), [8, 108, 208, 308])
  assert.deepEqual([wide.left[3].w, wide.left[3].h, wide.left[3].bottom, wide.left[3].tier], [60, 52, 100, 2])
  assert.equal(wide.reserve.left, 8 + 3 * 92 + 60 + 3 * 8 + 16)
  assert.deepEqual(placeBuildings(SHED, 1400).left.map((p) => p.key), ['cabin1', 'cabin2', 'cabin3'], 'a quarter of 1400 is 350: the shed goes, all three cabins stay')
  assert.deepEqual(placeBuildings(SHED, 1200).left.map((p) => p.key), ['cabin2', 'cabin3'], 'then the outermost cabin')
  assert.deepEqual(placeBuildings(built({ shed: 1 }), 1200).left.map((p) => [p.key, p.x]), [['shed', 8]], 'with no cabins the shed is at the edge')
  // Camps beat buildings: a crowded middle drops the shed before any cabin
  const sessions = Array.from({ length: 9 }, (_, i) => s(`c${i}`))
  const crowded = placeBuildings(SHED, 1600, sessions)
  const bare = campLayout(sessions, 1600)
  const now = campLayout(sessions, 1600, crowded.reserve)
  assert.ok(now.moreTents <= bare.moreTents && now.grouped === bare.grouped, 'every camp the bare strip shows')
  assert.deepEqual(crowded.left.map((p) => p.key), ['cabin2', 'cabin3'], 'the shed went first, then the outermost cabin')
})
