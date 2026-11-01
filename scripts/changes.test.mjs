// scripts/changes.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { changesTabLabel, startsExpanded } from '../src/shared/changes.ts'

const file = (added, deleted, extra = {}) => ({
  path: 'f',
  status: 'modified',
  added,
  deleted,
  binary: false,
  ...extra
})

test('label falls back to Changes without a summary or without changes', () => {
  assert.equal(changesTabLabel(null), 'Changes')
  assert.equal(changesTabLabel({ base: null, files: [] }), 'Changes')
})

test('label totals files and lines', () => {
  assert.equal(
    changesTabLabel({ base: 'main', files: [file(40, 7), file(2, 0)] }),
    '2 files +42 −7'
  )
})

test('label uses the singular for one file', () => {
  assert.equal(changesTabLabel({ base: 'main', files: [file(1, 1)] }), '1 file +1 −1')
})

test('files start expanded up to 1500 changed lines', () => {
  assert.equal(startsExpanded(file(1000, 500)), true)
  assert.equal(startsExpanded(file(1000, 501)), false)
})

test('binary files never start expanded', () => {
  assert.equal(startsExpanded(file(0, 0, { binary: true })), false)
})

test('files too large to read never start expanded', () => {
  assert.equal(startsExpanded(file(0, 0, { tooLarge: true })), false)
})
