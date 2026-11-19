// scripts/campsiteHiker.test.mjs — the campsite plugin's hikers: a look from a session id, pixels
// for each pose, stances, chores and labels.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HATS, JACKETS, NEUTRAL_JACKET, fnv1a, lookFor } from '../plugins/campsite/shared/hiker.ts'

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
