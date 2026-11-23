// scripts/campsiteWorldScene.test.mjs — the world on the strip (campsite part 3d-1), its pure half:
// the backdrop and the mountain in a palette (dusk exactly as before), winter's snow caps, autumn's
// rusted pines, spring's flowers clear of everything that takes a click, the particle pool (its cap,
// its motion in place, its reduced-motion layout) and fog's bands.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HIKER_W, LOG_W, TENT_W, campLayout } from '../plugins/campsite/shared/layout.ts'
import { PEAK_SNOW_Y, mountain, mountainLook } from '../plugins/campsite/shared/mountain.ts'
import { GROUND_Y, RIDGE_SNOW_Y, backdrop } from '../plugins/campsite/shared/stage.ts'
import { FOG_BANDS, PARTICLE_MAX, STILL_COUNT, flowers, fogWidth, fogX, newPool, particlesFor, seedPool, stepPool } from '../plugins/campsite/shared/touches.ts'
import { DUSK_WORLD, PALETTES, paletteAt } from '../plugins/campsite/shared/world.ts'

const ys = (points) => points.filter((_, i) => i % 2 === 1)

test("backdrop: the dusk palette is the strip as it was (the default); the sky over everything, ten stars, a crescent, no snow", () => {
  const b = backdrop(1000)
  assert.deepEqual(backdrop(1000, PALETTES.dusk), b)
  assert.equal(b.sky, '#1a1622')
  assert.deepEqual([b.starAlpha, b.moreStarAlpha, b.biteAlpha], [1, 0, 1])
  assert.equal(b.moreStars.length, 12)
  assert.deepEqual(b.snow, [])
  assert.deepEqual(b.bite.fill, b.sky)
  assert.deepEqual([...new Set(b.pines.map((p) => p.fill))].sort(), ['#17141d', '#1e1a27'])
})

test('backdrop: by day no stars and a full disc; at night the extra stars; winter snow on the ridge\'s highest tops; autumn rusts every third pine', () => {
  const day = backdrop(1000, paletteAt('day', 'dusk', 0, null))
  assert.deepEqual([day.starAlpha, day.biteAlpha, day.sky], [0, 0, PALETTES.day.sky])
  assert.equal(backdrop(1000, paletteAt('night', 'dawn', 0, null)).moreStarAlpha, 1)
  const winter = backdrop(1000, paletteAt('dusk', 'night', 0, 'winter'))
  assert.ok(winter.snow.length >= 3 && winter.snow.length <= 5, `${winter.snow.length} caps`)
  for (const cap of winter.snow) assert.ok(ys(cap.points).every((y) => y <= RIDGE_SNOW_Y))
  const autumn = backdrop(1000, paletteAt('dusk', 'night', 0, 'autumn'))
  const rust = paletteAt('dusk', 'night', 0, 'autumn').pineRust
  assert.deepEqual(autumn.pines.map((p, i) => (p.fill === rust) === (i % 3 === 0)), autumn.pines.map(() => true))
})

test('mountainLook: dusk with no season gives the peak and path back as they were; winter caps the top above PEAK_SNOW_Y', () => {
  const m = mountain(600, 900)
  const dusk = mountainLook(m, PALETTES.dusk)
  assert.deepEqual(dusk.shapes, [m.peak])
  assert.deepEqual(dusk.path, m.path)
  const winter = mountainLook(m, paletteAt('dusk', 'night', 0, 'winter'))
  assert.equal(winter.shapes.length, 2)
  assert.ok(ys(winter.shapes[1].points).every((y) => y <= PEAK_SNOW_Y))
  const day = mountainLook(m, PALETTES.day)
  assert.equal(day.shapes[0].fill, PALETTES.day.peak)
  assert.deepEqual([...new Set(day.path.map((b) => b.fill))].sort(), [PALETTES.day.ledge, PALETTES.day.path].sort())
})

let n = 0
const s = (worktreeId, over = {}) => ({ terminalId: `t${++n}`, label: 'Claude', provider: 'claude', status: 'working', decision: false, worktreeId, worktreeName: worktreeId, branch: worktreeId && `b/${worktreeId}`, ...over })

test("flowers: on the ground line between the buildings, never over a tent, the log, a hiker or the fire; at most 40", () => {
  const layout = campLayout([s('w1'), s('w2'), s(null), s('w1', { status: 'attention' })], 1400, { left: 200, right: 150 })
  const edges = { reserve: { left: 200, right: 150 } }
  const boxes = flowers(layout, edges)
  assert.ok(boxes.length > 0)
  assert.ok(boxes.length <= 80)
  const spans = [[layout.fireX - 34, layout.fireX + 34], ...layout.tents.map((t) => [t.x - TENT_W / 2, t.x + TENT_W / 2]), [layout.log.x - LOG_W / 2, layout.log.x + LOG_W / 2], ...layout.hikers.map((h) => [h.x - HIKER_W / 2, h.x + HIKER_W / 2])]
  for (const b of boxes) {
    assert.ok(b.x >= 200 && b.x + b.w <= 1400 - 150, `inside the middle: ${b.x}`)
    assert.ok(b.y + b.h <= GROUND_Y + 3 && b.y >= GROUND_Y - 5)
    for (const [a, z] of spans) assert.ok(b.x + b.w <= a || b.x >= z, `${b.x} clear of ${a}–${z}`)
  }
  assert.deepEqual(flowers(campLayout([], 0), { reserve: { left: 0, right: 0 } }), [])
})

test('particlesFor: the weather first (rain, heavy snow), then the season (light snow, leaves, fireflies at dusk and night); fog and a plain day none', () => {
  assert.deepEqual(particlesFor({ ...DUSK_WORLD, weather: 'rain', season: 'autumn' }), { kind: 'rain', count: 60 })
  assert.deepEqual(particlesFor({ ...DUSK_WORLD, weather: 'snow', season: 'winter' }), { kind: 'snow', count: 48 })
  assert.deepEqual(particlesFor({ ...DUSK_WORLD, season: 'winter' }), { kind: 'snow', count: 18 })
  assert.deepEqual(particlesFor({ ...DUSK_WORLD, season: 'autumn' }), { kind: 'leaf', count: 10 })
  assert.deepEqual(particlesFor({ ...DUSK_WORLD, season: 'summer' }), { kind: 'firefly', count: 14 })
  assert.deepEqual(particlesFor({ ...DUSK_WORLD, phase: 'night', season: 'summer' }), { kind: 'firefly', count: 14 })
  assert.equal(particlesFor({ ...DUSK_WORLD, phase: 'day', season: 'summer' }), null)
  assert.equal(particlesFor({ ...DUSK_WORLD, weather: 'fog' }), null)
  assert.equal(particlesFor({ ...DUSK_WORLD, season: 'spring' }), null)
  assert.equal(particlesFor(DUSK_WORLD), null)
})

/** A seeded random: the same numbers every run */
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

test('the pool: PARTICLE_MAX particles made once; never more on than that; moved in place, and wrapped back above the strip past the ground', () => {
  assert.equal(PARTICLE_MAX, 60)
  const pool = newPool()
  assert.equal(pool.length, 60)
  seedPool(pool, 'rain', 500, 1000, seeded(), false)
  assert.equal(pool.filter((p) => p.on).length, 60)
  seedPool(pool, 'snow', 18, 1000, seeded(), false)
  assert.equal(pool.filter((p) => p.on).length, 18)
  const objects = [...pool]
  const before = pool.map((p) => p.y)
  stepPool(pool, 'snow', 50, 1000, 1000, seeded(2))
  assert.ok(pool.every((p, i) => p === objects[i]), 'the same objects')
  assert.ok(pool.every((p, i) => !p.on || p.y > before[i] || p.y < 0), 'snow falls (or starts again above the strip)')
  assert.ok(pool.every((p, i) => p.on || p.y === before[i]), 'the off ones are left alone')
  seedPool(pool, 'rain', 60, 1000, seeded(), false)
  for (let i = 0; i < 100; i++) stepPool(pool, 'rain', 1000, i * 1000, 1000, seeded(i + 3))
  for (const p of pool) assert.ok(p.y <= GROUND_Y + 2 && p.x >= -8 && p.x <= 1008, `${p.x}, ${p.y}`)
})

test('the pool under reduced motion: a few of each kind, at fixed places (whatever the random numbers); fireflies stay low', () => {
  for (const kind of ['rain', 'snow', 'leaf', 'firefly']) {
    const a = newPool()
    const b = newPool()
    seedPool(a, kind, 60, 1000, seeded(1), true)
    seedPool(b, kind, 60, 1000, seeded(99), true)
    assert.equal(a.filter((p) => p.on).length, STILL_COUNT[kind])
    assert.deepEqual(a, b)
  }
  const flies = newPool()
  seedPool(flies, 'firefly', 14, 1000, seeded(), true)
  assert.ok(flies.filter((p) => p.on).every((p) => p.y >= 56 && p.y <= GROUND_Y - 4))
})

test("fog: three bands low over the camp, two copies each half a run apart, drifting within [-width, strip); still under reduced motion", () => {
  assert.equal(FOG_BANDS.length, 3)
  for (const band of FOG_BANDS) assert.ok(band.y >= 50 && band.y + band.h <= GROUND_Y + 6 && band.alpha <= 0.25)
  const w = fogWidth(1000)
  assert.equal(w, 800)
  for (const band of FOG_BANDS) {
    for (const t of [0, 5000, 123_456, 9e6]) {
      for (const copy of [0, 1]) {
        const x = fogX(band, copy, 1000, t, false)
        assert.ok(x >= -w && x < 1000, `${x}`)
      }
    }
    assert.equal(fogX(band, 0, 1000, 0, true), fogX(band, 0, 1000, 9e6, true))
    assert.notEqual(fogX(band, 0, 1000, 0, false), fogX(band, 0, 1000, 60_000, false))
  }
})
