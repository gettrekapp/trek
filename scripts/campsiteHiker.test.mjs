// scripts/campsiteHiker.test.mjs — the campsite plugin's hikers: a look from a session id, pixels
// for each pose, stances, chores and labels.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HATS, JACKETS, NEUTRAL_JACKET, fnv1a, lookFor } from '../plugins/campsite/shared/hiker.ts'
import { FRAMES, POSES, pixels } from '../plugins/campsite/shared/pixels.ts'

test('fnv1a: the 32-bit FNV-1a of the text', () => {
  assert.equal(fnv1a(''), 0x811c9dc5)
  assert.equal(fnv1a('a'), 0xe40c292c)
})

test('lookFor: the same look for the same id; jacket by provider, neutral when unknown', () => {
  assert.deepEqual(lookFor('t-1', 'claude'), lookFor('t-1', 'claude'))
  assert.equal(lookFor('t-1', 'claude').jacket, JACKETS.claude)
  assert.equal(lookFor('t-1', 'codex').jacket, JACKETS.codex)
  assert.equal(lookFor('t-1', 'mystery').jacket, NEUTRAL_JACKET)
  assert.equal(lookFor('t-1', 'constructor').jacket, NEUTRAL_JACKET, "Object's own names are not providers")
  const { jacket: _a, ...rest1 } = lookFor('t-1', 'claude')
  const { jacket: _b, ...rest2 } = lookFor('t-1', 'gemini')
  assert.deepEqual(rest1, rest2, 'the provider changes only the jacket')
})

test('lookFor: looks spread out (no hat on more than 35% of 1000 sessions; beards near 30%)', () => {
  const hats = new Map()
  let beards = 0
  for (let i = 0; i < 1000; i++) {
    const look = lookFor(`session-${i}`, 'claude')
    hats.set(look.hat, (hats.get(look.hat) ?? 0) + 1)
    if (look.beard) beards++
  }
  assert.equal(hats.size, HATS.length)
  for (const [hat, n] of hats) assert.ok(n <= 350, `${hat}: ${n}`)
  assert.ok(beards > 220 && beards < 380, `beards: ${beards}`)
})

test('pixels: every pose and frame stays on the 12×16 grid (a sign may sit above it)', () => {
  const look = lookFor('grid', 'claude')
  for (const pose of POSES) {
    for (let frame = 0; frame < FRAMES[pose]; frame++) {
      const rects = pixels(look, pose, frame)
      assert.ok(rects.length > 10, `${pose}/${frame} draws a hiker`)
      for (const r of rects) {
        assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 12 && r.y + r.h <= 16, `${pose}/${frame}: ${JSON.stringify(r)}`)
        assert.match(r.fill, /^#[0-9a-f]{6}$/i)
      }
    }
  }
})

test("pixels: the jacket and the hat show; a two-frame pose's frames differ; gear can be overridden", () => {
  const look = { ...lookFor('x', 'codex'), hat: 'beanie' }
  const fills = (rects) => new Set(rects.map((r) => r.fill))
  assert.ok(fills(pixels(look, 'stand', 0)).has(look.jacket))
  assert.ok(fills(pixels(look, 'stand', 0)).has(look.hatColor))
  for (const pose of POSES.filter((p) => FRAMES[p] === 2)) assert.notDeepEqual(pixels(look, pose, 0), pixels(look, pose, 1), pose)
  const withMug = pixels({ ...look, gear: 'pole' }, 'sit', 0, 'mug')
  assert.ok(withMug.some((r) => r.fill === '#e6e1d3'), 'the mug')
})
