// scripts/serverPluginCommand.test.mjs — `trek-server plugin add | remove | list` (theme plugins
// phase 1): it works on the data dir's plugins-installed folder, from a folder, a file or a URL.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from '../server/src/cli.ts'
import { runPluginCommand } from '../server/src/plugins/command.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

const MANIFEST = { id: 'solarized', version: '1.0.0', name: 'Solarized', description: 'A theme.', type: 'theme', contract: 1 }

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'trek-plugin-command-'))
  t.after(() => removeDir(root))
  const dataDir = join(root, 'data')
  const configPath = join(root, 'config.json')
  writeFileSync(configPath, JSON.stringify({ repos: [], dataDir }))
  // The home and the platform's data dir the command falls back on: never the real ones.
  const places = { home: join(root, 'home'), dataDir: join(root, 'platform-data') }
  /** `config: false` leaves --config out (--local takes none); the default config is then never read. */
  const run = async (argv, pages = {}, { config = configPath } = {}) => {
    const out = []
    const err = []
    const code = await runPluginCommand(parseArgs(config === false ? argv : [...argv, '--config', config]), {
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      fetch: async (url) => (pages[url] === undefined ? new Response('', { status: 404 }) : new Response(pages[url]))
    }, places)
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  return { root, dataDir, configPath, places, run }
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

test('--local works on the local server\'s data dir, and --local-profile on a named one', async (t) => {
  const s = setup(t)
  const file = join(s.root, 'solarized.trekplugin')
  writeFileSync(file, JSON.stringify({ manifest: MANIFEST, client: 'export default {}' }))
  const local = join(s.places.dataDir, 'local', 'plugins-installed')
  const dev = join(s.places.dataDir, 'local-dev', 'plugins-installed')

  const added = await s.run(['plugin', 'add', file, '--local'], {}, { config: false })
  assert.equal(added.code, 0, added.err)
  assert.ok(added.out.includes(`in ${local}.`), added.out)
  assert.ok(existsSync(join(local, 'solarized', 'client.js')))
  assert.equal(existsSync(join(s.dataDir, 'plugins-installed')), false, "not the config's data dir")
  assert.deepEqual(readdirSync(s.places.dataDir), ['local'], 'and nowhere else under the platform data dir')
  assert.equal(existsSync(s.places.home), false, 'nothing is written under the home')

  assert.match((await s.run(['plugin', 'list', '--local', '--local-profile', 'dev'], {}, { config: false })).out, /No plugins installed/)
  assert.equal((await s.run(['plugin', 'add', file, '--local', '--local-profile', 'dev'], {}, { config: false })).code, 0)
  assert.ok(existsSync(join(dev, 'solarized', 'manifest.json')))
  assert.match((await s.run(['plugin', 'list', '--local'], {}, { config: false })).out, /^solarized  1\.0\.0  theme  Solarized$/)
  const removed = await s.run(['plugin', 'remove', 'solarized', '--local'], {}, { config: false })
  assert.deepEqual([removed.code, removed.out.includes(`Removed solarized from ${local}.`)], [0, true])
  assert.ok(existsSync(join(dev, 'solarized')), 'the named profile keeps its own')
})

test('remove takes away a folder that is not listed, when it is a real folder named as an id', async (t) => {
  const s = setup(t)
  const dir = join(s.dataDir, 'plugins-installed')
  // A plugin whose manifest broke: warned about, not listed.
  mkdirSync(join(dir, 'broken'), { recursive: true })
  writeFileSync(join(dir, 'broken', 'manifest.json'), '{')
  writeFileSync(join(dir, 'broken', 'client.js'), 'export default {}')
  const list = await s.run(['plugin', 'list'])
  assert.match(list.out, /No plugins installed/)
  assert.match(list.err, /installed plugin broken not listed/)
  const removed = await s.run(['plugin', 'remove', 'broken'])
  assert.equal(removed.code, 0, removed.err)
  assert.equal(removed.out, `Removed the unlisted folder broken from ${dir}.`)
  assert.equal(existsSync(join(dir, 'broken')), false)
  const again = await s.run(['plugin', 'remove', 'broken'])
  assert.deepEqual([again.code, /No installed plugin with id "broken"/.test(again.err)], [1, true])

  // Not an id: nothing outside the folder, and no dot folder, is ever removed.
  mkdirSync(join(s.root, 'precious'))
  mkdirSync(join(dir, '.tmp-keep'))
  writeFileSync(join(dir, 'afile'), 'x')
  for (const target of ['../../precious', '.tmp-keep', '.', '..', 'afile']) {
    const refused = await s.run(['plugin', 'remove', target])
    assert.deepEqual([refused.code, /No installed plugin/.test(refused.err)], [1, true], target)
  }
  assert.ok(existsSync(join(s.root, 'precious')) && existsSync(join(dir, '.tmp-keep')) && existsSync(join(dir, 'afile')))
})

test('remove does not follow a link that is not listed', { skip: posixOnly('symbolic links need no privilege') }, async (t) => {
  const s = setup(t)
  const dir = join(s.dataDir, 'plugins-installed')
  mkdirSync(join(s.root, 'elsewhere'))
  writeFileSync(join(s.root, 'elsewhere', 'kept'), 'x')
  mkdirSync(dir, { recursive: true })
  symlinkSync(join(s.root, 'elsewhere'), join(dir, 'linked'))
  const refused = await s.run(['plugin', 'remove', 'linked'])
  assert.deepEqual([refused.code, /No installed plugin with id "linked"/.test(refused.err)], [1, true])
  assert.ok(existsSync(join(dir, 'linked')) && existsSync(join(s.root, 'elsewhere', 'kept')))
})

test('a config that cannot be read is said, and the default data dir used; no config at all is silent', async (t) => {
  const s = setup(t)
  const fallback = join(s.places.dataDir, 'plugins-installed')
  const missing = await s.run(['plugin', 'list'], {}, { config: join(s.root, 'no-such-config.json') })
  assert.deepEqual([missing.code, missing.err, missing.out], [0, '', `No plugins installed (${fallback}).`])

  const broken = join(s.root, 'broken.json')
  writeFileSync(broken, '{ "dataDir": ')
  const warned = await s.run(['plugin', 'list'], {}, { config: broken })
  assert.equal(warned.code, 0, 'and it carries on')
  assert.equal(warned.out, `No plugins installed (${fallback}).`)
  assert.ok(warned.err.startsWith(`Cannot read ${broken}: `), warned.err)
  assert.ok(warned.err.endsWith(`; using the default data dir ${s.places.dataDir}`), warned.err)
  assert.equal(warned.err.split('\n').length, 1)

  // --data-dir needs no config: nothing to say.
  const given = await s.run(['plugin', 'list', '--data-dir', join(s.root, 'elsewhere')], {}, { config: broken })
  assert.deepEqual([given.code, given.err], [0, ''])
  // A config with no dataDir is no problem either.
  writeFileSync(broken, JSON.stringify({ repos: [] }))
  assert.equal((await s.run(['plugin', 'list'], {}, { config: broken })).err, '')
})

test('the real entry runs the command from source and exits with its code', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trek-plugin-entry-'))
  t.after(() => removeDir(root))
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const dataDir = join(root, 'data')
  // Its own home too: nothing of the real one is read, whatever the command falls back on.
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), XDG_DATA_HOME: join(root, 'xdg-data'), XDG_CONFIG_HOME: join(root, 'xdg-config') }
  const entry = (...argv) => spawnSync(process.execPath, ['server/src/index.ts', ...argv, '--data-dir', dataDir, '--config', join(root, 'config.json')], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 })
  const list = entry('plugin', 'list')
  assert.equal(list.status, 0, list.stderr)
  assert.equal(list.stdout, `No plugins installed (${join(dataDir, 'plugins-installed')}).\n`)
  const missing = entry('plugin', 'remove', 'nope')
  assert.equal(missing.status, 1, missing.stderr)
  assert.match(missing.stderr, /No installed plugin with id "nope"/)
  assert.equal(missing.stdout, '')
})
