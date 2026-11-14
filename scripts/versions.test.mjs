// scripts/versions.test.mjs — version comparison shared by the app's updater and the Local server supervisor.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions } from '../src/shared/versions.ts'

test('compareVersions: numeric, part by part; anything unparsable compares equal', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1)
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), 0)
  assert.equal(compareVersions('x', '0.0.0'), 0)
})
