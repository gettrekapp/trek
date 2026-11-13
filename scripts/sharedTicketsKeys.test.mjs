// Named keys, shared by desktop and server. (Ticket parsing and links are the trackers' plugins'
// since plugin system phase 2: scripts/linearPlugin.test.mjs, scripts/azureDevOpsPlugin.test.mjs,
// and core's generic tickets in scripts/tickets.test.mjs.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { KEY_SEQUENCES, keySequence } from '../src/shared/keys.ts'

test('keySequence maps named keys and passes literal text', () => {
  assert.equal(keySequence('enter'), '\r')
  assert.equal(keySequence('ctrl-c'), '\x03')
  assert.equal(keySequence('hello'), 'hello')
  assert.equal(KEY_SEQUENCES.esc, '\x1b')
})
