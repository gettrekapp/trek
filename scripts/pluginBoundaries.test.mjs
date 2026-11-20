// scripts/pluginBoundaries.test.mjs — the plugin boundary (plugin system phase 1). A plugin's code
// (plugins/<id>/) imports only the plugin contract (src/shared/plugins/), its own folder and npm
// packages: not the rest of src/shared (the protocol's or the model's internals), never server/src, src/main, src/renderer, src/host, src/web or another
// plugin. Core imports a plugin only through plugins/builtin.*.ts (CORE_IMPORT_EXCEPTIONS, none since plugins A2).
// That is what lets a plugin
// become a package later with only the loader changing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = /\.(ts|tsx|mts)$/
const IMPORT = /(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g

function* walk(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (SOURCE.test(name)) yield path
  }
}

/** Each relative import in `file`, resolved to a repo-relative path (with `/`). */
export function relativeImports(file) {
  const text = readFileSync(file, 'utf8')
  const out = []
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (spec.startsWith('.')) out.push(relative(root, resolve(dirname(file), spec)).split(sep).join('/'))
  }
  return out
}

const pluginDir = join(root, 'plugins')
const pluginOf = (repoPath) => (repoPath.startsWith('plugins/') ? repoPath.split('/')[1] : undefined)
const BUILTIN = /^plugins\/builtin\.[a-z]+(\.ts)?$/

test("a plugin's code imports only the contract and its own folder", () => {
  const problems = []
  for (const file of walk(pluginDir)) {
    const from = relative(root, file).split(sep).join('/')
    if (BUILTIN.test(from)) continue
    const own = pluginOf(from)
    for (const target of relativeImports(file)) {
      const ok = target.startsWith('src/shared/plugins/') || pluginOf(target) === own
      if (!ok) problems.push(`${from} imports ${target}`)
    }
  }
  assert.deepEqual(problems, [])
})

/**
 * Core files allowed to import a plugin's file other than plugins/builtin.*.ts, each until the
 * phase that moves their importers into the plugin. Never add one for new code.
 */
const CORE_IMPORT_EXCEPTIONS = [
  // None since plugins A2: the static agent table's five re-exports went with the table.
]

test('core imports a plugin only through plugins/builtin.*.ts (and the listed exceptions)', () => {
  const problems = []
  const used = new Set()
  for (const dir of ['src', 'server/src']) {
    for (const file of walk(join(root, dir))) {
      const from = relative(root, file).split(sep).join('/')
      for (const target of relativeImports(file)) {
        if (!target.startsWith('plugins/') || BUILTIN.test(target)) continue
        const allowed = CORE_IMPORT_EXCEPTIONS.find((e) => e.from === from && e.to === target)
        if (allowed) used.add(allowed)
        else problems.push(`${from} imports ${target}`)
      }
    }
  }
  assert.deepEqual(problems, [])
  assert.deepEqual(CORE_IMPORT_EXCEPTIONS.filter((e) => !used.has(e)), [], 'a stale exception: drop it')
})

test('an exception stays a bare re-export: no code of its own, so nothing new grows on the plugin\'s file', () => {
  for (const { from, to } of CORE_IMPORT_EXCEPTIONS) {
    const code = readFileSync(join(root, from), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))
    assert.deepEqual(code, [`export * from '${relative(dirname(join(root, from)), join(root, to)).split(sep).join('/')}'`], from)
  }
})

test('the plugin contract (src/shared/plugins) imports no core code beyond src/shared and its three host helpers', () => {
  const problems = []
  for (const file of walk(join(root, 'src/shared/plugins'))) {
    for (const target of relativeImports(file)) {
      if (!target.startsWith('src/shared/') && target !== 'src/host/httpBody.ts' && target !== 'src/host/atomicWrite.ts' && target !== 'src/host/pathContainment.ts') {
        problems.push(`${relative(root, file)} imports ${target}`)
      }
    }
  }
  assert.deepEqual(problems, [])
})

test('the example theme is installable only: not listed in plugins/builtin.*.ts', () => {
  for (const name of ['builtin.client.ts', 'builtin.server.ts']) {
    assert.equal(readFileSync(join(pluginDir, name), 'utf8').includes('example-theme'), false, name)
  }
  assert.ok(existsSync(join(pluginDir, 'example-theme', 'client', 'index.ts')), 'and the boundary walk above covers its folder')
})
