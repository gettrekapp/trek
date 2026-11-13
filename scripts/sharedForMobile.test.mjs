// The phone (6a, apps/mobile) imports src/shared/client, src/shared/model and src/shared/protocolV2
// straight from the repo (Metro watchFolders). This walks the import graph from those entry points
// and fails on anything React Native can't run: node:* and Node built-ins, electron, a package the
// phone doesn't have, or the DOM's document/window globals.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not .pathname: on Windows that is /D:/… , which resolve() reads as a path on the current drive.
const root = fileURLToPath(new URL('..', import.meta.url))
/** What apps/mobile imports from the shared code (keep in step with apps/mobile/src/shared.ts). */
export const MOBILE_ENTRIES = ['src/shared/client/index.ts', 'src/shared/model/topics.ts', 'src/shared/model/types.ts', 'src/shared/protocolV2.ts', 'src/shared/types.ts', 'src/shared/promote.ts', 'src/shared/push.ts']
/** Packages the phone also has (none today: the shared code is dependency-free). */
const ALLOWED_PACKAGES = new Set([])

/**
 * A static import or export-from, over any number of lines: `import x from '…'`, `import '…'`,
 * `import {\n a,\n b\n} from '…'`, `export * from '…'`, `export { a } from '…'`, `import type …`.
 * The clause between the keyword and `from` may hold anything but a quote or a semicolon.
 */
export const IMPORT_RE = /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\bfrom\s*)?['"]([^'"\n]+)['"]/g
/** `import('…')` (any spacing, over lines) and `require('…')`. */
export const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g
/** A DOM global used as a value (not in a comment or a type position we can tell apart cheaply), also as `globalThis.document` or `self.…`. */
export const DOM_RE = /(?:(?<![\w.$'"])|(?<=\bglobalThis\.))(document|window|localStorage|sessionStorage|navigator)\s*[.[(]|(?<![\w.$'"])(self)\s*\./
/** A Node global React Native doesn't have. */
export const NODE_GLOBAL_RE = /(?<![\w.$'"])(Buffer|process|setImmediate|__dirname|__filename)\b(?!\s*:)|(?<![\w.$'"])(require)\s*\(/

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

/** String and template literals emptied (their quotes kept), so text in them isn't taken for code. */
const stripStrings = (src) => src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => `${m[0]}${m[0]}`)

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
    const code = stripStrings(src)
    const dom = DOM_RE.exec(code)
    if (dom) problems.push(`${rel}: uses the DOM global ${dom[1] ?? dom[2]}`)
    const node = NODE_GLOBAL_RE.exec(code)
    if (node) problems.push(`${rel}: uses the Node global ${node[1] ?? node[2]}`)
  }
  return { files: [...seen.keys()].map((f) => relative(root, f)).sort(), problems }
}

test('the shared code the phone imports runs on React Native: no Node, Electron, DOM or packages', () => {
  const { files, problems } = walk()
  assert.ok(files.length >= MOBILE_ENTRIES.length, `walked ${files.length} files`)
  assert.deepEqual(problems, [])
})

test("apps/mobile/src/shared.ts imports only these entry points", () => {
  const src = readFileSync(join(root, 'apps/mobile/src/shared.ts'), 'utf8')
  const imported = [...src.matchAll(/from '\.\.\/\.\.\/\.\.\/(src\/shared\/[^']+)'/g)].map((m) => m[1])
  assert.ok(imported.length > 0)
  for (const path of imported) assert.ok(MOBILE_ENTRIES.includes(path), `${path} is not in MOBILE_ENTRIES`)
})

const specsOf = (src) => {
  const specs = [...src.matchAll(IMPORT_RE)].map((m) => m[1])
  for (const m of src.matchAll(DYNAMIC_RE)) specs.push(m[1] ?? m[2])
  return specs
}

test('the guard catches what it should: imports over lines, export-from, dynamic import, Node and DOM globals', () => {
  assert.deepEqual(specsOf("import { readFile } from 'node:fs'"), ['node:fs'])
  assert.deepEqual(specsOf("import {\n  readFile,\n  writeFile\n} from 'node:fs'\n"), ['node:fs'])
  assert.deepEqual(specsOf("import type {\n  A\n} from\n  'node:path'"), ['node:path'])
  assert.deepEqual(specsOf("export * from './a.ts'\nexport { b,\n c } from \"./b.ts\"\nexport type { D } from './d.ts'"), ['./a.ts', './b.ts', './d.ts'])
  assert.deepEqual(specsOf("import './side-effect.ts'; import x from 'electron'"), ['./side-effect.ts', 'electron'])
  assert.deepEqual(specsOf("const m = await import(\n  'node:os'\n)\nconst r = require ('fs')"), ['node:os', 'fs'])
  assert.deepEqual(specsOf("const s = 'import x from \\'nope\\''\nexport const y = 1"), [])
  assert.equal(DOM_RE.test('const x = document.title'), true)
  assert.equal(DOM_RE.test('const x = globalThis.document.title'), true)
  assert.equal(DOM_RE.test('self.postMessage(1)'), true)
  assert.equal(DOM_RE.test("const s = 'document.title'"), false)
  assert.equal(DOM_RE.test('globalThis.WebSocket'), false)
  assert.equal(DOM_RE.test('this.self.x'), false)
  for (const bad of ['Buffer.from(x)', 'process.env.X', 'setImmediate(f)', 'const d = __dirname', 'join(__filename)', "const fs = require('fs')"]) {
    assert.equal(NODE_GLOBAL_RE.test(bad), true, bad)
  }
  for (const fine of ['const o = { process: 1 }', 'o.process()', 'const myBuffer = 1', "const s = 'process'", 'interface X { process: string }']) {
    assert.equal(NODE_GLOBAL_RE.test(stripStrings(fine)), false, fine)
  }
})
