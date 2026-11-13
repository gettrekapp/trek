// scripts/testPlatform.test.mjs — every platform skip in the unit tests goes through
// testPlatform.mjs (it says why, and the Windows CI job's skip count means something); none is
// an early `return` that would pass silently.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const dir = fileURLToPath(new URL('.', import.meta.url))

test('platform skips name a reason (posixOnly/windowsOnly), never a bare process.platform', () => {
  const bad = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.test.mjs') && n !== 'testPlatform.test.mjs')) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n')
    lines.forEach((line, i) => {
      const where = `${name}:${i + 1}: ${line.trim()}`
      // A skip option, or a skip value kept in a const, decided by a raw platform check.
      if (/\bskip\b[^,}]*process\.platform[^,}]*'win32'/.test(line)) bad.push(where)
      // A test that passes on Windows by returning early.
      if (/if \(process\.platform (===|!==) 'win32'\) return\b/.test(line)) bad.push(where)
    })
  }
  assert.deepEqual(bad, [], `use posixOnly()/windowsOnly() from scripts/testPlatform.mjs:\n${bad.join('\n')}`)
})
