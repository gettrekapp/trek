// scripts/providers.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { joinCommand, shellQuote } from '../src/shared/providers/shell.ts'

test('shellQuote wraps in single quotes and escapes embedded ones', () => {
  assert.equal(shellQuote('plain'), `'plain'`)
  assert.equal(shellQuote(`it's`), `'it'\\''s'`)
  assert.equal(shellQuote('$(rm -rf ~); `x`'), `'$(rm -rf ~); \`x\`'`)
})

test('joinCommand trims parts and drops empty ones', () => {
  assert.equal(joinCommand([' claude ', '', '  ', '--x']), 'claude --x')
})
