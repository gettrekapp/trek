// scripts/mainGhBinary.test.mjs — main's gh honours TREK_SERVER_GH as the server's does (5c-1 review).
import test from 'node:test'
import assert from 'node:assert/strict'
import { ghBinary } from '../src/main/ghBinary.ts'

test('unset: gh on the PATH; an absolute path: that one; anything else: no gh (fails closed)', () => {
  assert.equal(ghBinary(undefined), 'gh')
  assert.equal(ghBinary('/tmp/stub/gh'), '/tmp/stub/gh')
  assert.equal(ghBinary('gh'), null)
  assert.equal(ghBinary('stub/gh'), null)
  assert.equal(ghBinary(''), null)
})
