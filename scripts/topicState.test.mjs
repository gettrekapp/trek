// scripts/topicState.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyStatePatch } from '../src/shared/sync/topicState.ts'

const start = { snapshot: { n: 0 }, rev: 5 }
const patch = (rev, value = rev) => ({ topic: 'server', rev, ops: [{ op: 'replace', path: '/n', value }] })

test('the next rev applies and advances', () => {
  const out = applyStatePatch(start, patch(6))
  assert.equal(out.kind, 'applied')
  assert.deepEqual(out.state, { snapshot: { n: 6 }, rev: 6 })
  assert.deepEqual(start, { snapshot: { n: 0 }, rev: 5 })
})

test('an already-seen rev is stale', () => {
  assert.deepEqual(applyStatePatch(start, patch(5)), { kind: 'stale' })
  assert.deepEqual(applyStatePatch(start, patch(2)), { kind: 'stale' })
})

test('a skipped rev asks for a resync', () => {
  assert.deepEqual(applyStatePatch(start, patch(7)), { kind: 'resync', reason: 'gap' })
})

test('a patch that does not apply asks for a resync', () => {
  const bad = { topic: 'server', rev: 6, ops: [{ op: 'remove', path: '/missing' }] }
  assert.deepEqual(applyStatePatch(start, bad), { kind: 'resync', reason: 'invalid' })
})

test('applies a run of patches in order', () => {
  let state = start
  for (const rev of [6, 7, 8]) {
    const out = applyStatePatch(state, patch(rev))
    assert.equal(out.kind, 'applied')
    state = out.state
  }
  assert.deepEqual(state, { snapshot: { n: 8 }, rev: 8 })
})

test('malformed ops ask for a resync', () => {
  assert.deepEqual(applyStatePatch(start, { topic: 'server', rev: 6, ops: [null] }), {
    kind: 'resync',
    reason: 'invalid'
  })
})
