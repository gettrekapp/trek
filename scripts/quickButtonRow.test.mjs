// scripts/quickButtonRow.test.mjs — the quick buttons' single row: what overflows, and the More menu's order.
import test from 'node:test'
import assert from 'node:assert/strict'
import { moreLabel, moveButton, overflowCount, queueLabel, splitOverflow } from '../src/renderer/src/quickButtonRow.ts'

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

const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
const ids = (l) => l.map((b) => b.id).join('')

test('moveButton: drops before or after the target', () => {
  assert.equal(ids(moveButton(list, 'a', 'c', 'before')), 'bacd')
  assert.equal(ids(moveButton(list, 'a', 'c', 'after')), 'bcad')
  assert.equal(ids(moveButton(list, 'd', 'a', 'before')), 'dabc')
  assert.equal(ids(moveButton(list, 'b', 'd', 'after')), 'acdb')
})

test('moveButton: the same id or a missing one leaves the list as it was', () => {
  assert.equal(moveButton(list, 'b', 'b', 'after'), list)
  assert.equal(moveButton(list, 'x', 'b', 'after'), list)
  assert.equal(moveButton(list, 'b', 'x', 'after'), list)
})
