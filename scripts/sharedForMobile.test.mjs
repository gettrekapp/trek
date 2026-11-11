// The phone (6a, apps/mobile) imports src/shared/client, src/shared/model and src/shared/protocolV2
// straight from the repo (Metro watchFolders). This walks the import graph from those entry points
// and fails on anything React Native can't run: node:* and Node built-ins, electron, a package the
// phone doesn't have, or the DOM's document/window globals.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
/** What apps/mobile imports from the shared code (keep in step with apps/mobile/src/shared.ts). */
export const MOBILE_ENTRIES = ['src/shared/client/index.ts', 'src/shared/model/topics.ts', 'src/shared/model/types.ts', 'src/shared/protocolV2.ts']
/** Packages the phone also has (none today: the shared code is dependency-free). */
const ALLOWED_PACKAGES = new Set([])

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"\n;]*?\s+from\s+)?['"]([^'"]+)['"]/g
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
/** A DOM global used as a value (not in a comment or a type position we can tell apart cheaply). */
const DOM_RE = /(?<![\w.$'"])(document|window|localStorage|sessionStorage|navigator)\s*[.[(]/

function resolveLocal(from, spec) {
  const base = resolve(dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try {
        readFileSync(candidate)
        return candidate
      } catch {
        // a directory
      }
    }
  }
  return null
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

function walk() {
  const seen = new Map()
  const problems = []
  const queue = MOBILE_ENTRIES.map((e) => join(root, e))
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file)) continue
    const src = stripComments(readFileSync(file, 'utf8'))
    seen.set(file, true)
    const rel = relative(root, file)
    const specs = [...src.matchAll(IMPORT_RE)].map((m) => m[1])
    for (const m of src.matchAll(DYNAMIC_RE)) specs.push(m[1] ?? m[2])
    for (const spec of specs) {
      if (spec.startsWith('.')) {
        const target = resolveLocal(file, spec)
        if (!target) problems.push(`${rel}: cannot resolve ${spec}`)
        else if (!relative(join(root, 'src', 'shared'), target).startsWith('..')) queue.push(target)
        else problems.push(`${rel}: imports ${relative(root, target)}, outside src/shared`)
      } else if (spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0])) {
        problems.push(`${rel}: imports the Node built-in ${spec}`)
      } else if (spec === 'electron' || spec.startsWith('electron/')) {
        problems.push(`${rel}: imports electron`)
      } else if (!ALLOWED_PACKAGES.has(spec)) {
        problems.push(`${rel}: imports the package ${spec}, which the phone does not have`)
      }
    }
    const dom = DOM_RE.exec(src)
    if (dom) problems.push(`${rel}: uses the DOM global ${dom[1]}`)
  }
  return { files: [...seen.keys()].map((f) => relative(root, f)).sort(), problems }
}

test('the shared code the phone imports runs on React Native: no Node, Electron, DOM or packages', () => {
  const { files, problems } = walk()
  assert.ok(files.length >= MOBILE_ENTRIES.length, `walked ${files.length} files`)
  assert.deepEqual(problems, [])
})

test('the guard catches what it should (a planted Node import and a DOM global)', () => {
  assert.match("import { readFile } from 'node:fs'", IMPORT_RE)
  IMPORT_RE.lastIndex = 0
  assert.equal(DOM_RE.test('const x = document.title'), true)
  assert.equal(DOM_RE.test("const s = 'document.title'"), false)
  assert.equal(DOM_RE.test('globalThis.WebSocket'), false)
})
