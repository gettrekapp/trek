// scripts/quickButtonRow.test.mjs — the quick buttons' single row: what overflows, and the More menu's order.
import test from 'node:test'
import assert from 'node:assert/strict'
import { moreLabel, overflowCount, queueLabel, splitOverflow } from '../src/renderer/src/quickButtonRow.ts'

test('overflowCount: nothing overflows an empty row or one whose buttons share a line', () => {
  assert.equal(overflowCount([]), 0)
  assert.equal(overflowCount([8, 8, 8]), 0)
})

test('overflowCount: buttons laid out below the first line are out of sight', () => {
  assert.equal(overflowCount([8, 8, 38, 38, 68]), 3)
})

test('splitOverflow: the last buttons are the ones behind More', () => {
  assert.deepEqual(splitOverflow(['a', 'b', 'c', 'd'], 1), { shown: ['a', 'b', 'c'], more: ['d'] })
  assert.deepEqual(splitOverflow(['a', 'b'], 0), { shown: ['a', 'b'], more: [] })
})

test('splitOverflow: a count outside the list is clamped', () => {
  assert.deepEqual(splitOverflow(['a', 'b'], 5), { shown: [], more: ['a', 'b'] })
  assert.deepEqual(splitOverflow(['a', 'b'], -1), { shown: ['a', 'b'], more: [] })
})

test('labels: More counts what is hidden; Queue counts only when something is queued', () => {
  assert.equal(moreLabel(2), '2 more')
  assert.equal(queueLabel(0), 'Queue')
  assert.equal(queueLabel(3), 'Queue · 3')
})
