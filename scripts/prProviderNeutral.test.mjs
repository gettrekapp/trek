// scripts/prProviderNeutral.test.mjs — after plugins P3, GitHub lives in plugins/github only: no
// github.com link pattern and no gh invocation in core code (the server, the app, the renderer, the
// web client, the phone). Comments are allowed to mention GitHub; code is not.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['server/src', 'src/main', 'src/renderer/src', 'src/web', 'src/shared', 'src/host', 'apps/mobile/src', 'apps/mobile/app']
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

/** The file's text without // and /* *\/ comments (good enough for this check: no comment markers inside these files' strings matter). */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')

/**
 * The exceptions, each tied to one file and a narrow line pattern, with the reason it is not PR
 * hosting code. Never add an entry for code that parses, links, reads or watches a pull request:
 * that belongs in plugins/github.
 */
const ALLOWED = [
  // Trek's own release feed (Trek is published on GitHub Releases), not pull requests.
  { file: 'server/src/update/keys.ts', line: /^export const UPDATE_FEED = 'https:\/\/github\.com\/gettrekapp\/trek\/releases'$/ },
  { file: 'src/shared/appUpdate.ts', line: /^export const RELEASES_URL = 'https:\/\/github\.com\/gettrekapp\/trek\/releases'$/ },
  // The bot's OS sandbox policy: an agent's own `gh pr create`/`gh pr merge`/pulls write asks the
  // user first. It gates commands an agent runs; it is not how Trek reaches a PR host.
  { file: 'src/host/bot/shellCommand.ts', line: /return \['gh pr (create|merge)'\]|\? \['gh pr merge'\] : \[\]$|^\} else if \(name === 'gh'\) \{$/ },
  // The phone's offline demo server: a sample link, read through the github provider like any other.
  { file: 'apps/mobile/src/demo/demoData.ts', line: /^const PR_URL = 'https:\/\/github\.com\/example\/acme-web\/pull\/42'$/ }
]

/** A github.com host name (also escaped, as in a link regex) or a gh invocation. */
const PR_CODE = /github\\?\.com|['"`]gh['"`]|\bgh (pr|api|auth)\b/

test('no GitHub PR code outside plugins/github', () => {
  const problems = []
  const used = new Set()
  for (const dir of DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file).split(sep).join('/')
      const lines = code(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (!PR_CODE.test(line)) return
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

test('the check sees PR code it must catch', () => {
  const hits = (text) => code(text).split('\n').filter((l) => PR_CODE.test(l))
  assert.equal(hits("const re = /^https:\\/\\/github\\.com\\/([\\w.-]+)\\/pull\\/(\\d+)$/").length, 1, 'a link regex counts')
  assert.equal(hits("const url = 'https://github.com/o/r/pull/1'").length, 1)
  assert.equal(hits("execFile('gh', ['pr', 'view'])").length, 1)
  assert.equal(hits("const hint = `gh pr checks ${url}`").length, 1)
  assert.equal(hits('// gh pr view is run by the plugin').length, 0, 'comments may mention gh')
  assert.equal(hits('/* see github.com */ const x = 1').length, 0)
})
