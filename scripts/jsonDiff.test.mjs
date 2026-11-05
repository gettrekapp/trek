// scripts/jsonDiff.test.mjs — structural diff whose output applyPatch turns a into b.
import test from 'node:test'
import assert from 'node:assert/strict'
import { deepEqual, diffJson } from '../src/shared/sync/jsonDiff.ts'
import { applyPatch } from '../src/shared/sync/jsonPatch.ts'

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

test('arrays of different length are replaced whole', () => {
  assert.deepEqual(diffJson({ xs: [1, 2] }, { xs: [1, 2, 3] }), [
    { op: 'replace', path: '/xs', value: [1, 2, 3] }
  ])
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
  for (const [a, b] of cases) assert.deepEqual(applyPatch(a, diffJson(a, b)), b)
})
