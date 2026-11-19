// scripts/colimaNeutral.test.mjs — after plugins E2, Colima lives in plugins/colima on the server's
// side: no colima invocation, docker context, VM name, registry file or env.* method, and no import
// of the env helpers, in the server's code (server/src) or the host services (src/host). Comments
// may mention Colima; code may not. The client half (the renderer, the web client, src/shared and
// the phone) follows in plugins E3, with this check widened to them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['server/src', 'src/host']
const SKIP = new Set(['node_modules', 'dist', 'out'])

function* walk(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.generated.ts')) yield path
  }
}

/** The file's text without // and /* *\/ comments (good enough for this check, as in prProviderNeutral.test.mjs). */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')

/**
 * The exceptions, each tied to one file and a narrow line pattern, with the reason it is not
 * Colima code. Never add one for code that runs colima, names a VM or reads the registry: that
 * belongs in plugins/colima.
 */
const ALLOWED = [
  // remove_worktree's description tells the agent what a default teardown covers (the plugin's VM among them).
  { file: 'server/src/mcp/tools.ts', line: /^"Delete a linked worktree: .*its Colima VM, a plugin's part\).*",$/ },
  // The dev stacks' take-over gate: a data dir with the pre-E2 registry took over before E2, so its
  // stacks are not seeded again. It only checks the file is there; it never reads it.
  { file: 'server/src/integrations/stackSeed.ts', line: /^const LEGACY_SEED_MARKER = 'environments\.json'$/ }
]

/** colima (the program, the docker context `colima-…`, the word in a string), the registry file, a twb- VM name, an env.* method or event name, the env helpers. */
const COLIMA_CODE = /colima|environments\.json|\btwb-|['"`]env\.(check|list|up|stop|destroy|ps|composeFiles|logs|log)['"`]|deriveProfileName|envRepoKey|shared\/environments/i

test('no Colima code in the server or the host services outside plugins/colima', () => {
  const problems = []
  const used = new Set()
  for (const dir of DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file).split(sep).join('/')
      const lines = code(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (!COLIMA_CODE.test(line)) return
        const allowed = ALLOWED.find((a) => a.file === rel && a.line.test(line.trim()))
        if (allowed) return void used.add(allowed)
        problems.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
  }
  assert.deepEqual(problems, [])
  // An exception that no longer matches anything is stale: drop it rather than let it excuse new code.
  assert.deepEqual(ALLOWED.filter((a) => !used.has(a)).map((a) => a.file), [])
})

test('the check sees the Colima code it must catch', () => {
  const hits = (text) => code(text).split('\n').filter((l) => COLIMA_CODE.test(l))
  assert.equal(hits("execFile('colima', ['list', '--json'])").length, 1)
  assert.equal(hits("const args = ['--context', `colima-${profile}`]").length, 1)
  assert.equal(hits("const file = join(dataDir, 'environments.json')").length, 1)
  assert.equal(hits("const PREFIX = 'twb-'").length, 1)
  assert.equal(hits("'env.up': (p, ctx) => up(p)").length, 1)
  assert.equal(hits("ctx.events?.send('env.log', event)").length, 1)
  assert.equal(hits("import { envRepoKey } from '../../../src/shared/environments.ts'").length, 1)
  assert.equal(hits('// colima runs in the plugin').length, 0, 'comments may mention it')
  assert.equal(hits("'branch.setEnv': (p, ctx) => setEnv(p)").length, 0, "the old branch method is core's mirror, not Colima code")
  assert.equal(hits('if (repo.environments) mirror(repo)').length, 0)
})
