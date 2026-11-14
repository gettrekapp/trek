// scripts/testPlatform.test.mjs — every Windows skip in the unit tests goes through
// testPlatform.mjs (it says why, and the Windows CI job's skip count means something); none is
// an early `return` that would pass silently.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const dir = fileURLToPath(new URL('.', import.meta.url))

// A raw Windows check: process.platform (or os's platform()) against 'win32', in any quotes, either way round.
const PLATFORM = String.raw`(?:process\.platform|\bplatform\(\))`
const WIN32 = String.raw`["'\x60]win32["'\x60]`
const WIN_CHECK = new RegExp(`${PLATFORM}\\s*[!=]==?\\s*${WIN32}|${WIN32}\\s*[!=]==?\\s*${PLATFORM}`)

/** The lines of a test file that skip on Windows without posixOnly()/windowsOnly(), or pass there by returning early. */
export function rawWindowsSkips(text) {
  const lines = text.split('\n')
  // Names that hold a raw Windows check (`const isWin = process.platform === "win32"`).
  const flags = new Set()
  for (const line of lines) {
    const m = /\b(?:const|let|var)\s+(\w+)\s*=(.*)$/.exec(line)
    if (m && WIN_CHECK.test(m[2])) flags.add(m[1])
  }
  const usesFlag = (text) => [...flags].some((name) => new RegExp(`(?<![\\w.])${name}(?![\\w])`).test(text))
  const bad = []
  lines.forEach((line, i) => {
    // A skip option (`skip: …`, or `{ skip }` for a const named skip), decided by a raw check.
    const option = /\bskip\s*:(.*)$/.exec(line)?.[1] ?? (/[{,]\s*skip\s*[,}]/.test(line) ? 'skip' : null)
    if (option !== null && (WIN_CHECK.test(option) || usesFlag(option))) bad.push(i + 1)
    // A test that passes on Windows by returning early.
    const early = /\bif\s*\((.*)\)\s*return\b/.exec(line)?.[1]
    if (early !== undefined && (WIN_CHECK.test(early) || usesFlag(early))) bad.push(i + 1)
  })
  return bad
}

test('rawWindowsSkips: catches each spelling, and leaves posixOnly/windowsOnly and non-skip uses alone', () => {
  const flagged = [
    "test('x', { skip: process.platform === 'win32' }, () => {})",
    'test(\'x\', { skip: process.platform === "win32" && "no sh" }, () => {})',
    "test('x', { skip: 'win32' === process.platform }, () => {})",
    "test('x', { skip: platform() === 'win32' }, () => {})",
    "  if (process.platform === 'win32') return",
    '  if (process.platform !== "win32") return',
    'const isWin = process.platform === "win32"\ntest(\'x\', { skip: isWin && "no sh" }, () => {})',
    "const skip = process.platform === 'win32' && 'no sh'\ntest('x', { skip }, () => {})",
    "const win = process.platform === 'win32'\ntest('x', () => {\n  if (win) return\n})"
  ]
  for (const text of flagged) assert.notDeepEqual(rawWindowsSkips(text), [], text)
  const fine = [
    "test('x', { skip: posixOnly('a POSIX shell') }, () => {})",
    "const skip = posixOnly('sh')\ntest('x', { skip }, () => {})",
    "const sep = process.platform === 'win32' ? '\\\\' : '/'",
    "const winOnly = process.platform === 'win32'\nassert.equal(winOnly, false)",
    "test('x', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {})"
  ]
  for (const text of fine) assert.deepEqual(rawWindowsSkips(text), [], text)
})

test('platform skips name a reason (posixOnly/windowsOnly), never a bare process.platform', () => {
  const bad = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.test.mjs') && n !== 'testPlatform.test.mjs')) {
    const text = readFileSync(join(dir, name), 'utf8')
    const lines = text.split('\n')
    for (const n of rawWindowsSkips(text)) bad.push(`${name}:${n}: ${lines[n - 1].trim()}`)
  }
  assert.deepEqual(bad, [], `use posixOnly()/windowsOnly() from scripts/testPlatform.mjs:\n${bad.join('\n')}`)
})
