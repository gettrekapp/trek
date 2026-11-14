// scripts/childOptions.test.mjs — every child process in server/src, src/host and the plugins'
// server halves (plugins/<id>/server) passes its options through hidden() (windowsHide), so a
// server without a console never flashes windows, and names its program through commandPath() (src/host/commandPath.ts), so on Windows a bare
// name is never looked up in the current directory (a repository's planted git.exe).
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hidden } from '../src/host/childOptions.ts'

const root = join(fileURLToPath(import.meta.url), '..', '..')
// The plugins' server halves run in the server too (plugin system phase 1).
const PLUGIN_SERVERS = readdirSync(join(root, 'plugins'))
  .map((id) => `plugins/${id}/server`)
  .filter((dir) => existsSync(join(root, dir)) && statSync(join(root, dir)).isDirectory())
const TREES = ['server/src', 'src/host', ...PLUGIN_SERVERS]
/** Calls that are not child_process ones, or that never run on Windows. */
const ALLOWED = new Set([
  // The bot refuses to start on win32 (src/host/bot/sandbox.ts), so its processes never run there.
  'src/host/bot/turnProcess.ts',
  'src/host/bot/sandbox.ts'
])
// The program a call runs: commandPath(…), this very Node, or a choice between the two.
const PROGRAM = /^(commandPath\(.*\)|process\.execPath|\w+ \? (process\.execPath|commandPath\(.*\)) : (process\.execPath|commandPath\(.*\)))$/s
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

/** The call's first argument, up to its first top-level comma. */
function firstArg(text) {
  let depth = 0
  let quote = null
  for (let i = 1; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth-- === 0) return text.slice(1, i).trim()
    } else if (c === ',' && depth === 0) return text.slice(1, i).trim()
  }
  return text.slice(1).trim()
}

test('hidden() adds windowsHide and keeps the rest', () => {
  assert.deepEqual(hidden({ timeout: 5 }), { timeout: 5, windowsHide: true })
})

test("the scan covers the plugins' server halves", () => {
  assert.ok(TREES.includes('plugins/voice/server'))
})

test('every spawn/execFile in server/src, src/host and plugins/*/server uses hidden() and commandPath()', () => {
  const missing = []
  for (const tree of TREES) {
    for (const file of files(join(root, tree))) {
      // In '/' form on Windows too, as ALLOWED and the messages spell it.
      const rel = relative(root, file).split(sep).join('/')
      if (ALLOWED.has(rel)) continue
      const src = readFileSync(file, 'utf8')
      if (!/node:child_process/.test(src)) continue
      for (const m of src.matchAll(CALL)) {
        const text = callText(src, m.index + m[0].length - 1)
        const line = src.slice(0, m.index).split('\n').length
        if (!/\bhidden(<\w+>)?\(/.test(text)) missing.push(`${rel}:${line} ${m[1]}( without hidden()`)
        // The program: commandPath(…), or this very Node.
        const program = firstArg(text)
        if (!PROGRAM.test(program)) {
          missing.push(`${rel}:${line} ${m[1]}(${program}, …) without commandPath()`)
        }
      }
    }
  }
  assert.deepEqual(missing, [], `child processes without hidden() or commandPath():\n${missing.join('\n')}`)
})
