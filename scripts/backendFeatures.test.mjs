// scripts/backendFeatures.test.mjs — the feature sets a window backend reports.
import test from 'node:test'
import assert from 'node:assert/strict'
import { FEATURE_NAMES, LEGACY_FEATURES, V2_FEATURES, globalPanelMode, v2Features } from '../src/renderer/src/backendFeatures.ts'

test('both sets name exactly the known features', () => {
  const names = [...FEATURE_NAMES].sort()
  assert.deepEqual(Object.keys(LEGACY_FEATURES).sort(), names)
  assert.deepEqual(Object.keys(V2_FEATURES).sort(), names)
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length)
})

test('a project file window keeps every feature', () => {
  for (const name of FEATURE_NAMES) assert.equal(LEGACY_FEATURES[name], true, name)
})

test('a server window can have only the Global panel (Linear waits for phase 5)', () => {
  const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
  assert.deepEqual(on, ['globalPanel'])
})

test('v2 features are the ceiling AND the welcome capabilities', () => {
  const on = (caps) => FEATURE_NAMES.filter((name) => v2Features(caps)[name])
  assert.deepEqual(on(['mcp']), ['globalPanel'])
  assert.deepEqual(on([]), [])
  // Before the first welcome there are no capabilities.
  assert.deepEqual(on(undefined), [])
  // A capability the ceiling has off turns nothing on.
  assert.deepEqual(on(['mcp', 'docker', 'bot']), ['globalPanel'])
})

test('the same capabilities give the same object, so a React snapshot read is stable', () => {
  assert.equal(v2Features(['mcp']), v2Features(['mcp']))
  assert.equal(v2Features([]), v2Features(undefined))
  assert.notEqual(v2Features(['mcp']), v2Features([]))
})

test('the Global panel without its capability shows the sessions it has, read-only, and hides when there are none', () => {
  assert.equal(globalPanelMode(LEGACY_FEATURES, 0), 'full')
  assert.equal(globalPanelMode(v2Features(['mcp']), 0), 'full')
  assert.equal(globalPanelMode(v2Features([]), 2), 'readOnly')
  assert.equal(globalPanelMode(v2Features([]), 0), 'hidden')
})
