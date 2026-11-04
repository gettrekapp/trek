// scripts/jsonPatch.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch, formatPointer, parsePointer, PatchError } from '../src/shared/sync/jsonPatch.ts'

test('pointers round-trip, escaping ~ and /', () => {
  assert.deepEqual(parsePointer(''), [])
  assert.deepEqual(parsePointer('/a/b~1c/d~0e'), ['a', 'b/c', 'd~e'])
  assert.equal(formatPointer(['a', 'b/c', 'd~e']), '/a/b~1c/d~0e')
  assert.throws(() => parsePointer('a/b'), PatchError)
})

test('add, replace and remove object members', () => {
  const doc = { a: 1, b: { c: 2 } }
  const out = applyPatch(doc, [
    { op: 'add', path: '/b/d', value: 3 },
    { op: 'replace', path: '/a', value: 9 },
    { op: 'remove', path: '/b/c' }
  ])
  assert.deepEqual(out, { a: 9, b: { d: 3 } })
})

test('array insert, append, replace and remove', () => {
  const doc = { xs: ['a', 'c'] }
  const out = applyPatch(doc, [
    { op: 'add', path: '/xs/1', value: 'b' },
    { op: 'add', path: '/xs/-', value: 'd' },
    { op: 'replace', path: '/xs/0', value: 'A' },
    { op: 'remove', path: '/xs/3' }
  ])
  assert.deepEqual(out, { xs: ['A', 'b', 'c'] })
})

test('replacing the root returns the new value', () => {
  assert.deepEqual(applyPatch({ a: 1 }, [{ op: 'replace', path: '', value: { b: 2 } }]), { b: 2 })
})

test('input is never mutated and untouched branches are shared', () => {
  const doc = { a: { x: 1 }, b: { y: 2 } }
  const frozen = structuredClone(doc)
  const out = applyPatch(doc, [{ op: 'replace', path: '/a/x', value: 5 }])
  assert.deepEqual(doc, frozen)
  assert.equal(out.b, doc.b)
  assert.notEqual(out.a, doc.a)
})

test('bad paths throw PatchError and leave the input alone', () => {
  const doc = { a: [1], b: {} }
  const bad = [
    [{ op: 'replace', path: '/missing', value: 1 }],
    [{ op: 'remove', path: '/b/nope' }],
    [{ op: 'add', path: '/a/5', value: 1 }],
    [{ op: 'replace', path: '/a/-', value: 1 }],
    [{ op: 'add', path: '/a/01', value: 1 }],
    [{ op: 'add', path: '/x/y', value: 1 }],
    [{ op: 'remove', path: '' }],
    [{ op: 'add', path: '/__proto__/polluted', value: 1 }],
    [{ op: 'move', path: '/a', from: '/b' }],
    // first op is fine, second fails: the whole patch fails
    [{ op: 'replace', path: '/b', value: 1 }, { op: 'remove', path: '/zzz' }]
  ]
  for (const ops of bad) {
    assert.throws(() => applyPatch(doc, ops), PatchError, JSON.stringify(ops))
  }
  assert.deepEqual(doc, { a: [1], b: {} })
  assert.equal({}.polluted, undefined)
})

test('malformed ops throw PatchError, never a raw TypeError', () => {
  const bad = [null, [null], [{ op: 'add' }], [{ op: 'add', path: '/a' }], [{ op: 'replace', path: 7, value: 1 }]]
  for (const ops of bad) {
    assert.throws(() => applyPatch({ a: 1 }, ops), PatchError, JSON.stringify(ops))
  }
})

test('constructor and prototype are ordinary keys; only __proto__ is refused', () => {
  const added = applyPatch({}, [{ op: 'add', path: '/constructor', value: 1 }])
  assert.equal(Object.prototype.hasOwnProperty.call(added, 'constructor'), true)
  assert.equal(added.constructor, 1)
  const replaced = applyPatch(added, [{ op: 'replace', path: '/constructor', value: 2 }])
  assert.equal(replaced.constructor, 2)
  assert.equal(applyPatch({}, [{ op: 'add', path: '/prototype', value: 3 }]).prototype, 3)
})

test('parsePointer rejects invalid escapes', () => {
  assert.throws(() => parsePointer('/a~2'), PatchError)
  assert.throws(() => parsePointer('/a~'), PatchError)
})
