// scripts/jsonDiff.test.mjs — structural diff whose output applyPatch turns a into b.
import test from 'node:test'
import assert from 'node:assert/strict'
import { deepEqual, diffJson } from '../src/shared/sync/jsonDiff.ts'
import { applyPatch } from '../src/shared/sync/jsonPatch.ts'

const wire = (v) => JSON.parse(JSON.stringify(v))
function assertRoundTrip(a, b) {
  assert.deepEqual(applyPatch(wire(a), wire(diffJson(a, b))), wire(b))
}

test('equal documents give no ops', () => {
  assert.deepEqual(diffJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), [])
})

test('object members: add, remove, nested replace', () => {
  assert.deepEqual(diffJson({ a: 1, b: { c: 2 }, d: 0 }, { a: 1, b: { c: 3 }, e: 4 }), [
    { op: 'remove', path: '/d' },
    { op: 'replace', path: '/b/c', value: 3 },
    { op: 'add', path: '/e', value: 4 }
  ])
})

test('same-length arrays are diffed per index', () => {
  assert.deepEqual(diffJson({ xs: [{ n: 1 }, { n: 2 }] }, { xs: [{ n: 1 }, { n: 5 }] }), [
    { op: 'replace', path: '/xs/1/n', value: 5 }
  ])
})

test('arrays of different length: a grown prefix gets adds', () => {
  assert.deepEqual(diffJson({ xs: [1, 2] }, { xs: [1, 2, 3] }), [{ op: 'add', path: '/xs/2', value: 3 }])
})

test('an array that grows at the end gets add ops at the new indexes', () => {
  assert.deepEqual(diffJson({ xs: [1, { a: 1 }] }, { xs: [1, { a: 1 }, 3, 4] }), [
    { op: 'add', path: '/xs/2', value: 3 },
    { op: 'add', path: '/xs/3', value: 4 }
  ])
})

test('an array that shrinks at the end gets remove ops, last index first', () => {
  assert.deepEqual(diffJson({ xs: [1, 2, 3, 4] }, { xs: [1, 2] }), [
    { op: 'remove', path: '/xs/3' },
    { op: 'remove', path: '/xs/2' }
  ])
})

test('a shorter array that is not a prefix is still replaced whole', () => {
  assert.deepEqual(diffJson({ xs: [1, 2, 3] }, { xs: [2, 3] }), [{ op: 'replace', path: '/xs', value: [2, 3] }])
})

test('growing and shrinking round-trip through the wire', () => {
  const cases = [
    [{ s: [] }, { s: [{ id: 'a', q: [] }] }],
    [{ s: [{ id: 'a' }] }, { s: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }],
    [{ s: [{ id: 'a' }, { id: 'b' }] }, { s: [] }],
    [[1, 2, 3], [1]]
  ]
  for (const [a, b] of cases) assert.deepEqual(applyPatch(wire(a), wire(diffJson(a, b))), wire(b))
})

test('a changed root is replaced at ""', () => {
  assert.deepEqual(diffJson(1, 2), [{ op: 'replace', path: '', value: 2 }])
  assert.deepEqual(diffJson({ a: 1 }, [1]), [{ op: 'replace', path: '', value: [1] }])
})

test('keys with undefined values count as absent', () => {
  assert.deepEqual(diffJson({ a: undefined, b: 1 }, { b: 1 }), [])
  assert.deepEqual(diffJson({ b: 1 }, { a: undefined, b: 1 }), [])
  assert.equal(deepEqual({ a: undefined }, {}), true)
})

test('keys are escaped as JSON pointers', () => {
  assert.deepEqual(diffJson({}, { 'a/b': 1, 'c~d': 2 }), [
    { op: 'add', path: '/a~1b', value: 1 },
    { op: 'add', path: '/c~0d', value: 2 }
  ])
})

test('applyPatch(a, diffJson(a, b)) equals b', () => {
  const cases = [
    [{ server: { name: 'x', health: [] }, repos: [] }, { server: { name: 'y', health: [] }, repos: [{ id: 'a' }] }],
    [{ list: [{ id: 1, tags: ['a'] }, { id: 2 }] }, { list: [{ id: 1, tags: ['b'] }, { id: 2, x: null }] }],
    [{ a: { b: { c: 1 } } }, { a: { b: {} } }],
    [{ a: null }, { a: { b: 1 } }],
    [[1, 2, 3], [3, 2, 1]]
  ]
  for (const [a, b] of cases) {
    assert.deepEqual(applyPatch(a, diffJson(a, b)), b)
    assertRoundTrip(a, b)
  }
})

test('inherited Object.prototype names are ordinary keys', () => {
  for (const k of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.deepEqual(diffJson({}, { [k]: 1 }), [{ op: 'add', path: '/' + k, value: 1 }])
    assert.deepEqual(diffJson({ [k]: 1 }, {}), [{ op: 'remove', path: '/' + k }])
    assert.deepEqual(diffJson({ [k]: 1 }, { [k]: 2 }), [{ op: 'replace', path: '/' + k, value: 2 }])
    assert.equal(deepEqual({}, { [k]: 1 }), false)
    assert.equal(deepEqual({ [k]: 1 }, {}), false)
    assertRoundTrip({}, { [k]: 1 })
    assertRoundTrip({ [k]: 1 }, {})
    assertRoundTrip({ [k]: 1 }, { [k]: 2 })
    assertRoundTrip({ a: { [k]: { x: 1 } } }, { a: { [k]: { x: 2 } } })
  }
})

test('an own __proto__ key throws with the path', () => {
  const evil = JSON.parse('{"__proto__": 1}')
  assert.throws(() => diffJson({}, evil), /__proto__/)
  assert.throws(() => diffJson(evil, {}), /__proto__/)
  assert.throws(() => diffJson({ a: { b: 1 } }, { a: JSON.parse('{"__proto__": 1}') }), /__proto__.*\/a|\/a.*__proto__/)
})

test('only plain JSON is diffed structurally', () => {
  const ops = diffJson({ d: new Date(1) }, { d: new Date(2) })
  assert.equal(ops.length, 1)
  assert.equal(ops[0].op, 'replace')
  assert.equal(ops[0].path, '/d')
  assert.deepEqual(diffJson({ n: NaN }, { n: NaN }), [])
  assert.deepEqual(diffJson({ n: 0 }, { n: -0 }), [])
})

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('seeded random pairs round-trip through the wire', () => {
  const rnd = mulberry32(12345)
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
  const keys = ['constructor', 'toString', 'a', 'b', 'x/y', 'm~n']
  const gen = (depth) => {
    const r = rnd()
    if (depth <= 0 || r < 0.4) {
      return pick([() => Math.floor(rnd() * 3), () => pick(['', 's', 't']), () => rnd() < 0.5, () => null])()
    }
    if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(depth - 1))
    const o = {}
    for (const k of keys) if (rnd() < 0.4) o[k] = gen(depth - 1)
    return o
  }
  for (let i = 0; i < 300; i++) {
    const a = gen(4)
    // bias toward related pairs so nested diffs get exercised
    const b = rnd() < 0.5 ? gen(4) : mutate(a)
    assertRoundTrip(a, b)
  }
  function mutate(v) {
    if (Array.isArray(v)) {
      const out = v.map((x) => (rnd() < 0.5 ? mutate(x) : x))
      // grow or shrink at the tail so add/remove ops get exercised
      const r = rnd()
      if (r < 0.25) out.push(gen(2))
      else if (r < 0.5 && out.length > 0) out.pop()
      return out
    }
    if (v && typeof v === 'object') {
      const o = {}
      for (const k of keys) {
        const own = Object.hasOwn(v, k)
        if (own && rnd() < 0.7) o[k] = mutate(v[k])
        else if (!own && rnd() < 0.2) o[k] = gen(2)
      }
      return o
    }
    return rnd() < 0.5 ? v : gen(1)
  }
})
