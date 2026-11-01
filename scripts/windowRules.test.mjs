// scripts/windowRules.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { boundsOnScreen, decideOpen, parseOpenWindows } from '../src/main/windowRules.ts'

test('an open project is focused, whatever the sender holds', () => {
  assert.equal(decideOpen(true, true), 'focus-existing')
  assert.equal(decideOpen(false, true), 'focus-existing')
})

test('a project opens in the sender only when the sender is empty', () => {
  assert.equal(decideOpen(false, false), 'use-sender')
  assert.equal(decideOpen(true, false), 'new-window')
})

test('parseOpenWindows drops bad entries and duplicates', () => {
  const bounds = { x: 1, y: 2, width: 3, height: 4 }
  assert.deepEqual(
    parseOpenWindows([
      { filePath: '/a', bounds },
      { filePath: '/a' },
      { filePath: '/b', bounds: { x: 'no' } },
      { filePath: 7 },
      null
    ]),
    [{ filePath: '/a', bounds }, { filePath: '/b' }]
  )
})

test('parseOpenWindows treats a non-array as nothing to restore', () => {
  assert.deepEqual(parseOpenWindows({ filePath: '/a' }), [])
  assert.deepEqual(parseOpenWindows(null), [])
})

test('boundsOnScreen needs an overlap with some display', () => {
  const displays = [
    { x: 0, y: 0, width: 1000, height: 800 },
    { x: 1000, y: 0, width: 500, height: 500 }
  ]
  assert.equal(boundsOnScreen({ x: 1200, y: 100, width: 100, height: 100 }, displays), true)
  assert.equal(boundsOnScreen({ x: 3000, y: 0, width: 100, height: 100 }, displays), false)
  assert.equal(boundsOnScreen({ x: 1000, y: 0, width: 100, height: 100 }, [displays[0]]), false)
})
