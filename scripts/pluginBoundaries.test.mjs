// scripts/pluginBoundaries.test.mjs — the plugin boundary (plugin system phase 1). A plugin's code
// (plugins/<id>/) imports only the plugin contract and shared code (src/shared/), its own folder
// and npm packages; never server/src, src/main, src/renderer, src/host, src/web or another
// plugin. Core imports a plugin only through plugins/builtin.*.ts. That is what lets a plugin
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

test("a plugin's code imports only the contract, shared code and its own folder", () => {
  const problems = []
  for (const file of walk(pluginDir)) {
    const from = relative(root, file).split(sep).join('/')
    if (BUILTIN.test(from)) continue
    const own = pluginOf(from)
    for (const target of relativeImports(file)) {
      const ok = target.startsWith('src/shared/') || pluginOf(target) === own
      if (!ok) problems.push(`${from} imports ${target}`)
    }
  }
  assert.deepEqual(problems, [])
})

test('core imports a plugin only through plugins/builtin.*.ts', () => {
  const problems = []
  for (const dir of ['src', 'server/src']) {
    for (const file of walk(join(root, dir))) {
      const from = relative(root, file).split(sep).join('/')
      for (const target of relativeImports(file)) {
        if (target.startsWith('plugins/') && !BUILTIN.test(target)) problems.push(`${from} imports ${target}`)
      }
    }
  }
  assert.deepEqual(problems, [])
})

test('the plugin contract (src/shared/plugins) imports no core code beyond src/shared and its two host helpers', () => {
  const problems = []
  for (const file of walk(join(root, 'src/shared/plugins'))) {
    for (const target of relativeImports(file)) {
      if (!target.startsWith('src/shared/') && target !== 'src/host/httpBody.ts' && target !== 'src/host/atomicWrite.ts') {
        problems.push(`${relative(root, file)} imports ${target}`)
      }
    }
  }
  assert.deepEqual(problems, [])
})
