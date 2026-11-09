// scripts/windowRules.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LABEL_LENGTH, MAX_TARGET_ID, boundsOnScreen, isTargetId, capLabel, decideOpen, initialFromTarget, parseOpenWindows, routeSelect, sameTarget, serializeOpenWindow } from '../src/main/windowRules.ts'

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
    [{ target: { kind: 'file', path: '/a' }, bounds }, { target: { kind: 'file', path: '/b' } }]
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

test('sameTarget compares file paths and server ids', () => {
  assert.equal(sameTarget({ kind: 'file', path: '/a.trekproj' }, { kind: 'file', path: '/a.trekproj' }), true)
  assert.equal(sameTarget({ kind: 'file', path: '/a.trekproj' }, { kind: 'file', path: '/b.trekproj' }), false)
  assert.equal(sameTarget({ kind: 'server', serverEntryId: 's', projectId: 'p' }, { kind: 'server', serverEntryId: 's', projectId: 'p' }), true)
  assert.equal(sameTarget({ kind: 'server', serverEntryId: 's', projectId: 'p' }, { kind: 'server', serverEntryId: 's', projectId: 'q' }), false)
  assert.equal(sameTarget({ kind: 'file', path: 'p' }, { kind: 'server', serverEntryId: 's', projectId: 'p' }), false)
})

test('parseOpenWindows reads legacy file entries and server entries', () => {
  assert.deepEqual(parseOpenWindows([
    { filePath: '/a.trekproj', bounds: { x: 1, y: 2, width: 3, height: 4 } },
    { kind: 'server', serverEntryId: 's1', projectId: 'p1' },
    { kind: 'server', serverEntryId: 's1', projectId: 'p1' },
    { kind: 'server', serverEntryId: '', projectId: 'p2' },
    { kind: 'server', serverEntryId: 's1' },
    { kind: 'file', path: '/b.trekproj' }
  ]), [
    { target: { kind: 'file', path: '/a.trekproj' }, bounds: { x: 1, y: 2, width: 3, height: 4 } },
    { target: { kind: 'server', serverEntryId: 's1', projectId: 'p1' } },
    { target: { kind: 'file', path: '/b.trekproj' } }
  ])
})

test('serializeOpenWindow writes a server window, with its bounds', () => {
  assert.deepEqual(serializeOpenWindow({ target: { kind: 'server', serverEntryId: 's', projectId: 'p' }, bounds: { x: 0, y: 0, width: 1, height: 1 } }), { kind: 'server', serverEntryId: 's', projectId: 'p', bounds: { x: 0, y: 0, width: 1, height: 1 } })
  assert.deepEqual(serializeOpenWindow({ target: { kind: 'server', serverEntryId: 's', projectId: 'p' } }), { kind: 'server', serverEntryId: 's', projectId: 'p' })
})

test('initialFromTarget hands the server ids, or null for an empty window', () => {
  assert.equal(initialFromTarget(null), null)
  assert.deepEqual(initialFromTarget({ kind: 'server', serverEntryId: 's', projectId: 'p' }), { serverEntryId: 's', projectId: 'p' })
})

test('capLabel coerces to a string and caps its length', () => {
  assert.equal(capLabel('box'), 'box')
  assert.equal(capLabel(''), '')
  assert.equal(capLabel(undefined), '')
  assert.equal(capLabel(null), '')
  assert.equal(capLabel(42), '42')
  assert.equal(capLabel('x'.repeat(500)).length, MAX_LABEL_LENGTH)
})

test('isTargetId takes non-empty strings up to MAX_TARGET_ID characters', () => {
  assert.equal(MAX_TARGET_ID, 200)
  assert.equal(isTargetId('s'), true)
  assert.equal(isTargetId('x'.repeat(200)), true)
  assert.equal(isTargetId('x'.repeat(201)), false)
  assert.equal(isTargetId(''), false)
  assert.equal(isTargetId(5), false)
})

test('parseOpenWindows drops server entries with over-long ids', () => {
  const long = 'x'.repeat(201)
  assert.deepEqual(parseOpenWindows([
    { kind: 'server', serverEntryId: long, projectId: 'p' },
    { kind: 'server', serverEntryId: 's', projectId: long },
    { kind: 'server', serverEntryId: 'x'.repeat(200), projectId: 'p' }
  ]), [{ target: { kind: 'server', serverEntryId: 'x'.repeat(200), projectId: 'p' } }])
})

test('a session select goes to a listening window, waits for a loading one, or opens one', () => {
  assert.equal(routeSelect({ rendererReady: true }), 'send')
  assert.equal(routeSelect({ rendererReady: false }), 'queue')
  assert.equal(routeSelect(undefined), 'open')
})
