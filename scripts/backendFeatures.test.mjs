// scripts/backendFeatures.test.mjs — the feature sets a window backend reports.
import test from 'node:test'
import assert from 'node:assert/strict'
import { FEATURE_NAMES, LEGACY_FEATURES, V2_FEATURES } from '../src/renderer/src/backendFeatures.ts'

test('both sets name exactly the known features', () => {
  const names = [...FEATURE_NAMES].sort()
  assert.deepEqual(Object.keys(LEGACY_FEATURES).sort(), names)
  assert.deepEqual(Object.keys(V2_FEATURES).sort(), names)
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length)
})

test('a project file window keeps every feature', () => {
  for (const name of FEATURE_NAMES) assert.equal(LEGACY_FEATURES[name], true, name)
})

test('a server window starts with every feature off (Linear waits for phase 5)', () => {
  const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
  assert.deepEqual(on, [])
})
