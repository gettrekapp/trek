// scripts/childOptions.test.mjs — every child process in server/src and src/host passes its
// options through hidden() (windowsHide), so a server without a console never flashes windows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hidden } from '../src/host/childOptions.ts'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const TREES = ['server/src', 'src/host']
/** Calls that are not child_process ones, or that never run on Windows. */
const ALLOWED = new Set([
  // The bot refuses to start on win32 (src/host/bot/sandbox.ts), so its processes never run there.
  'src/host/bot/turnProcess.ts',
  'src/host/bot/sandbox.ts'
])
// A bare call (not a method: `.spawn(` is node-pty's or TerminalHost's).
const CALL = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|execFileAsync|execSync|exec)\(/g

function files(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** The text of the call starting at `open` (the index of its `(`), up to its matching `)`. */
function callText(src, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

test('hidden() adds windowsHide and keeps the rest', () => {
  assert.deepEqual(hidden({ timeout: 5 }), { timeout: 5, windowsHide: true })
})

test('every spawn/execFile in server/src and src/host uses hidden()', () => {
  const missing = []
  for (const tree of TREES) {
    for (const file of files(join(root, tree))) {
      const rel = relative(root, file)
      if (ALLOWED.has(rel)) continue
      const src = readFileSync(file, 'utf8')
      if (!/node:child_process/.test(src)) continue
      for (const m of src.matchAll(CALL)) {
        const text = callText(src, m.index + m[0].length - 1)
        if (!/\bhidden(<\w+>)?\(/.test(text)) {
          const line = src.slice(0, m.index).split('\n').length
          missing.push(`${rel}:${line} ${m[1]}(`)
        }
      }
    }
  }
  assert.deepEqual(missing, [], `child processes without hidden():\n${missing.join('\n')}`)
})
