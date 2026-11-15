// scripts/serverPluginCommand.test.mjs — `trek-server plugin add | remove | list` (theme plugins
// phase 1): it works on the data dir's plugins-installed folder, from a folder, a file or a URL.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from '../server/src/cli.ts'
import { runPluginCommand } from '../server/src/plugins/command.ts'
import { removeDir } from './testPlatform.mjs'

const MANIFEST = { id: 'solarized', version: '1.0.0', name: 'Solarized', description: 'A theme.', type: 'theme', contract: 1 }

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'trek-plugin-command-'))
  t.after(() => removeDir(root))
  const dataDir = join(root, 'data')
  const configPath = join(root, 'config.json')
  writeFileSync(configPath, JSON.stringify({ repos: [], dataDir }))
  const run = async (argv, pages = {}) => {
    const out = []
    const err = []
    const code = await runPluginCommand(parseArgs([...argv, '--config', configPath]), {
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      fetch: async (url) => (pages[url] === undefined ? new Response('', { status: 404 }) : new Response(pages[url]))
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  return { root, dataDir, configPath, run }
}

test('add from a folder, a file and a URL; list; remove', async (t) => {
  const s = setup(t)
  assert.match((await s.run(['plugin', 'list'])).out, /No plugins installed/)

  mkdirSync(join(s.root, 'theme'))
  writeFileSync(join(s.root, 'theme', 'manifest.json'), JSON.stringify(MANIFEST))
  writeFileSync(join(s.root, 'theme', 'client.js'), 'export default {}')
  const added = await s.run(['plugin', 'add', join(s.root, 'theme')])
  assert.equal(added.code, 0, added.err)
  assert.match(added.out, /Installed Solarized \(solarized 1\.0\.0\)/)
  assert.match(added.out, /A running server picks it up/)
  assert.ok(existsSync(join(s.dataDir, 'plugins-installed', 'solarized', 'client.js')))

  const file = join(s.root, 'nord.trekplugin')
  writeFileSync(file, JSON.stringify({ manifest: { ...MANIFEST, id: 'nord', name: 'Nord' }, client: 'export default 2' }))
  assert.equal((await s.run(['plugin', 'add', file])).code, 0)
  const pages = { 'https://themes.test/gruv.trekplugin': JSON.stringify({ manifest: { ...MANIFEST, id: 'gruv', name: 'Gruv', version: '2.0.0' }, client: 'export default 3' }) }
  assert.equal((await s.run(['plugin', 'add', 'https://themes.test/gruv.trekplugin'], pages)).code, 0)

  const list = await s.run(['plugin', 'list'])
  assert.deepEqual(list.out.split('\n').map((line) => line.split(/\s+/).slice(0, 3).join(' ')), ['gruv 2.0.0 theme', 'nord 1.0.0 theme', 'solarized 1.0.0 theme'])

  const removed = await s.run(['plugin', 'remove', 'nord'])
  assert.deepEqual([removed.code, /Removed nord/.test(removed.out)], [0, true])
  assert.equal(existsSync(join(s.dataDir, 'plugins-installed', 'nord')), false)
})

test('failures exit 1 with the reason, and --data-dir overrides the config', async (t) => {
  const s = setup(t)
  const missing = await s.run(['plugin', 'remove', 'nope'])
  assert.deepEqual([missing.code, /No installed plugin with id "nope"/.test(missing.err)], [1, true])
  const builtIn = join(s.root, 'voice.trekplugin')
  writeFileSync(builtIn, JSON.stringify({ manifest: { ...MANIFEST, id: 'voice' }, client: 'x' }))
  const refused = await s.run(['plugin', 'add', builtIn])
  assert.deepEqual([refused.code, /built-in plugin/.test(refused.err)], [1, true])
  const insecure = await s.run(['plugin', 'add', 'http://themes.test/x.trekplugin'])
  assert.deepEqual([insecure.code, /https/.test(insecure.err)], [1, true])

  const elsewhere = join(s.root, 'elsewhere')
  const ok = join(s.root, 'ok.trekplugin')
  writeFileSync(ok, JSON.stringify({ manifest: MANIFEST, client: 'x' }))
  assert.equal((await s.run(['plugin', 'add', ok, '--data-dir', elsewhere])).code, 0)
  assert.ok(existsSync(join(elsewhere, 'plugins-installed', 'solarized')))
  assert.equal(existsSync(join(s.dataDir, 'plugins-installed')), false)
})
