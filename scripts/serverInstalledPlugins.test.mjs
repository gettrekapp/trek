// scripts/serverInstalledPlugins.test.mjs — trek-server's installed plugins (theme plugins phase
// 1): the plugins-installed folder read at start, add, replace and remove, what is skipped, the
// bundle and its hash, and who hears a change (one made here, or by another process).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstalledPlugins } from '../server/src/plugins/installed.ts'
import { installedIdReserved } from '../server/src/plugins/reserved.ts'
import { checkPluginPackage } from '../src/shared/plugins/manifest.ts'
import { removeDir } from './testPlatform.mjs'

const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const raw = (id = 'solarized', client = 'export default {}', more = {}) => ({
  manifest: { id, version: '1.0.0', name: id, description: 'A theme.', type: 'theme', contract: 1, ...more },
  client
})
const pkg = (...a) => checkPluginPackage(raw(...a)).package

function setup(t, { reserved = () => false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'trek-installed-'))
  t.after(() => removeDir(root))
  const dir = join(root, 'plugins-installed')
  const warnings = []
  const make = () => createInstalledPlugins({ dir, reserved, warn: (m) => warnings.push(m) })
  return { dir, warnings, make }
}
/** A plugin folder written by hand, as another process (or a person) would. */
function writeFolder(dir, name, manifest, client) {
  mkdirSync(join(dir, name), { recursive: true })
  if (manifest !== undefined) writeFileSync(join(dir, name, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  if (client !== undefined) writeFileSync(join(dir, name, 'client.js'), client)
}

test('add writes the two files, lists the plugin with its hash, and a new store reads it back', (t) => {
  const s = setup(t)
  const store = s.make()
  assert.deepEqual(store.list(), [])
  const added = store.add(pkg('solarized', 'export default { a: 1 }'))
  assert.equal(added.sha256, sha('export default { a: 1 }'))
  assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'solarized', 'manifest.json'), 'utf8')), added.manifest)
  assert.equal(readFileSync(join(s.dir, 'solarized', 'client.js'), 'utf8'), 'export default { a: 1 }')
  assert.deepEqual(store.presence(), [
    { id: 'solarized', version: '1.0.0', defaultEnabled: false, type: 'theme', name: 'solarized', description: 'A theme.', contract: 1, sha256: added.sha256 }
  ])
  assert.deepEqual(store.bundle('solarized'), { sha256: added.sha256, client: 'export default { a: 1 }' })
  assert.equal(store.bundle('nope'), undefined)
  assert.deepEqual(s.make().presence(), store.presence(), 'read back at start')
  assert.deepEqual(readdirSync(s.dir), ['solarized'], 'no temporary folder is left')
})

test('add replaces a plugin of the same id; remove deletes it', (t) => {
  const s = setup(t)
  const store = s.make()
  store.add(pkg('solarized', 'export default 1'))
  store.add(pkg('nord', 'export default 3'))
  const replaced = store.add(pkg('solarized', 'export default 2', { version: '1.1.0' }))
  assert.equal(replaced.sha256, sha('export default 2'))
  assert.deepEqual(store.list().map((p) => [p.manifest.id, p.manifest.version]), [['nord', '1.0.0'], ['solarized', '1.1.0']], 'sorted by id')
  assert.equal(store.remove('solarized'), true)
  assert.equal(store.remove('solarized'), false)
  assert.equal(existsSync(join(s.dir, 'solarized')), false)
  assert.deepEqual(store.list().map((p) => p.manifest.id), ['nord'])
})

test('a reserved id is refused as BAD_REQUEST and nothing is written', (t) => {
  const s = setup(t, { reserved: installedIdReserved([{ manifest: { id: 'voice' } }]) })
  const store = s.make()
  for (const id of ['voice', 'plugins', 'update', 'project']) {
    assert.throws(() => store.add(pkg(id)), (err) => err.code === 'BAD_REQUEST' && /built-in plugin or a core namespace/.test(err.message), id)
  }
  assert.equal(existsSync(s.dir) ? readdirSync(s.dir).length : 0, 0)
})

test('a folder that cannot be installed is skipped at start, with a warning', (t) => {
  const s = setup(t, { reserved: (id) => id === 'voice' })
  const good = raw('good')
  writeFolder(s.dir, 'good', good.manifest, good.client)
  writeFolder(s.dir, 'nomanifest', undefined, 'export default {}')
  writeFolder(s.dir, 'badjson', '{', 'export default {}')
  writeFolder(s.dir, 'noclient', raw('noclient').manifest)
  writeFolder(s.dir, 'other', raw('different').manifest, 'export default {}')
  writeFolder(s.dir, 'voice', raw('voice').manifest, 'export default {}')
  writeFolder(s.dir, 'feature', raw('feature', 'x', { type: 'feature' }).manifest, 'x')
  writeFolder(s.dir, 'Bad..Name', raw('solarized').manifest, 'export default {}')
  writeFolder(s.dir, 'notutf8', raw('notutf8').manifest, Buffer.from([0x65, 0xff, 0xfe]))
  writeFolder(s.dir, '.tmp-left-behind', raw('left').manifest, 'x')
  writeFileSync(join(s.dir, 'a-file'), 'x')
  const store = s.make()
  assert.deepEqual(store.list().map((p) => p.manifest.id), ['good'])
  for (const name of ['nomanifest', 'badjson', 'noclient', 'other', 'voice', 'feature', 'Bad..Name', 'notutf8']) {
    assert.ok(s.warnings.some((w) => w.includes(name)), `a warning names ${name}: ${JSON.stringify(s.warnings)}`)
  }
  assert.ok(!s.warnings.some((w) => w.includes('.tmp-left-behind') || w.includes('a-file')), 'dot folders and files are not plugins, and not warned about')
})

test('a change made here tells the listeners which ids changed', (t) => {
  const s = setup(t)
  const store = s.make()
  const heard = []
  const off = store.onChange((ids) => heard.push(ids))
  store.add(pkg('solarized'))
  store.add(pkg('solarized'))
  store.add(pkg('solarized', 'export default 2'))
  store.remove('solarized')
  store.remove('solarized')
  assert.deepEqual(heard, [['solarized'], ['solarized'], ['solarized']], 'the same bundle again is no change; nor is removing nothing')
  off()
  store.add(pkg('nord'))
  assert.equal(heard.length, 3)
})

test('rescan finds what another process changed, and says whether anything did', (t) => {
  const s = setup(t)
  const store = s.make()
  const heard = []
  store.onChange((ids) => heard.push(ids))
  assert.equal(store.rescan(), false)
  const other = s.make()
  other.add(pkg('solarized'))
  other.add(pkg('nord'))
  assert.equal(store.rescan(), true)
  assert.deepEqual(heard, [['nord', 'solarized']])
  other.remove('nord')
  other.add(pkg('solarized', 'export default 9'))
  assert.equal(store.rescan(), true)
  assert.deepEqual(heard[1], ['nord', 'solarized'])
  assert.equal(store.rescan(), false)
})

test('watch: a running store hears a change another process made in the folder', async (t) => {
  const s = setup(t)
  const store = s.make()
  t.after(() => store.dispose())
  store.watch()
  const heard = new Promise((done) => store.onChange(done))
  s.make().add(pkg('solarized'))
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('no change heard within 10 s')), 10_000).unref())
  assert.deepEqual(await Promise.race([heard, timeout]), ['solarized'])
})
