// scripts/v2Osc52.test.mjs — which OSC 52 payloads put text on the clipboard.
import test from 'node:test'
import assert from 'node:assert/strict'
import { OSC52_MAX_BASE64, osc52Text } from '../src/renderer/src/v2/osc52.ts'

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

test('a clipboard set decodes its UTF-8 text', () => {
  assert.equal(osc52Text(`c;${b64('hello world')}`), 'hello world')
  assert.equal(osc52Text(`;${b64('no target')}`), 'no target')
  assert.equal(osc52Text(`pc;${b64('héllo → ✓\nline 2')}`), 'héllo → ✓\nline 2')
})

test('a read, a clear or a malformed payload asks for nothing', () => {
  assert.equal(osc52Text('c;?'), null)
  assert.equal(osc52Text('c;'), null)
  assert.equal(osc52Text('no-semicolon'), null)
  assert.equal(osc52Text('c;not base64!'), null)
  assert.equal(osc52Text(`c;${Buffer.from([0xff, 0xfe]).toString('base64')}`), null)
})

test('an oversized payload is dropped', () => {
  assert.equal(osc52Text(`c;${'A'.repeat(OSC52_MAX_BASE64 + 4)}`), null)
})
