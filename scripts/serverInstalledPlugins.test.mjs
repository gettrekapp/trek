// scripts/serverInstalledPlugins.test.mjs — trek-server's installed plugins (theme plugins phase
// 1): the plugins-installed folder read at start, add, replace and remove, what is skipped, the
// bundle and its hash, and who hears a change (one made here, or by another process).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createInstalledPlugins } from '../server/src/plugins/installed.ts'
import { installedIdReserved } from '../server/src/plugins/reserved.ts'
import { checkPluginPackage } from '../src/shared/plugins/manifest.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

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
  assert.equal(readFileSync(join(s.dir, 'solarized', 'manifest.json'), 'utf8'), `${JSON.stringify(added.manifest)}\n`, 'compact: no larger than what was checked')
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
  assert.deepEqual(readdirSync(s.dir).sort(), ['nord', 'solarized'], 'the folder that stepped aside is gone, and no staging folder is left')
  assert.equal(readFileSync(join(s.dir, 'solarized', 'client.js'), 'utf8'), 'export default 2')
  assert.deepEqual(s.warnings, [])
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

/** Until `heard` has an entry (about 10 s at most): fs.watch is not always live when it returns, so one change made at once can be missed. */
async function changeUntilHeard(heard, change) {
  for (let n = 0; heard.length === 0 && n < 40; n++) {
    change(n)
    await sleep(250)
  }
}

test('watch: a running store hears a change another process made in the folder', async (t) => {
  const s = setup(t)
  const store = s.make()
  t.after(() => store.dispose())
  store.watch()
  const heard = []
  store.onChange((ids) => heard.push(ids))
  const other = s.make()
  await changeUntilHeard(heard, (n) => other.add(pkg('solarized', `export default ${n}`)))
  assert.deepEqual(heard[0], ['solarized'], 'no change heard within 10 s')
  assert.deepEqual(store.list().map((p) => p.manifest.id), ['solarized'])
})

test('watch: an edit inside a plugin folder is heard too', async (t) => {
  const s = setup(t)
  const store = s.make()
  t.after(() => store.dispose())
  store.add(pkg('solarized', 'export default 0'))
  store.watch()
  const heard = []
  store.onChange((ids) => heard.push(ids))
  const written = []
  await changeUntilHeard(heard, (n) => {
    written.push(sha(`export default "edit ${n}"`))
    writeFileSync(join(s.dir, 'solarized', 'client.js'), `export default "edit ${n}"`)
  })
  assert.deepEqual(heard[0], ['solarized'], 'no change heard within 10 s')
  assert.ok(written.includes(store.presence()[0].sha256), 'the presence has the hash of an edit')
})

/** fs.watch replaced by `fake` for the test: a watcher's own error, and a platform with no recursive watch, cannot be had from a real folder. */
function fakeWatch(t, fake) {
  const real = fs.watch
  fs.watch = fake
  syncBuiltinESMExports()
  t.after(() => {
    fs.watch = real
    syncBuiltinESMExports()
  })
}

test('watch: a watcher that fails is closed with a warning, and watch can be called again', (t) => {
  const s = setup(t)
  const watchers = []
  fakeWatch(t, () => {
    const watcher = Object.assign(new EventEmitter(), { closed: false, close() { this.closed = true } })
    watchers.push(watcher)
    return watcher
  })
  const store = s.make()
  t.after(() => store.dispose())
  store.watch()
  store.watch()
  assert.equal(watchers.length, 1, 'one watcher while it works')
  watchers[0].emit('error', new Error('EPERM: the folder went away'))
  assert.equal(watchers[0].closed, true)
  assert.ok(s.warnings.some((w) => /cannot watch .*EPERM/.test(w)), JSON.stringify(s.warnings))
  store.watch()
  assert.equal(watchers.length, 2, 'watched again')
  store.dispose()
  assert.equal(watchers[1].closed, true)
})

test('watch: recursive where the platform has it, and plain where asking for it throws', (t) => {
  const s = setup(t)
  const asked = []
  fakeWatch(t, (_dir, options) => {
    asked.push(options?.recursive === true)
    if (options?.recursive) throw Object.assign(new Error('The feature watch recursively is unavailable on the current platform'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
    return Object.assign(new EventEmitter(), { close() {} })
  })
  const store = s.make()
  t.after(() => store.dispose())
  store.watch()
  // This test's Node is 20 or later, so every platform asks for a recursive watch first.
  assert.deepEqual(asked, [true, false])
})

test('bundle: a client.js edited in place is noticed: the new hash, the listeners told, the presence updated', (t) => {
  const s = setup(t)
  const store = s.make()
  store.add(pkg('solarized', 'export default 1'))
  const heard = []
  store.onChange((ids) => heard.push(ids))
  writeFileSync(join(s.dir, 'solarized', 'client.js'), 'export default 2')
  assert.equal(store.presence()[0].sha256, sha('export default 1'), 'not known yet')
  assert.deepEqual(store.bundle('solarized'), { sha256: sha('export default 2'), client: 'export default 2' })
  assert.deepEqual(heard, [['solarized']])
  assert.equal(store.presence()[0].sha256, sha('export default 2'))
  assert.deepEqual(store.bundle('solarized'), { sha256: sha('export default 2'), client: 'export default 2' })
  assert.equal(heard.length, 1, 'the same bytes again are no change')
})

test('bundle: a client.js edited into something that cannot be installed is not handed out, and the plugin is no longer listed', (t) => {
  for (const [what, bytes] of [['not UTF-8', Buffer.from([0x65, 0xff, 0xfe])], ['larger than 1 MB', 'x'.repeat(1024 * 1024 + 1)], ['empty', '']]) {
    const s = setup(t)
    const store = s.make()
    store.add(pkg('solarized', 'export default 1'))
    const heard = []
    store.onChange((ids) => heard.push(ids))
    writeFileSync(join(s.dir, 'solarized', 'client.js'), bytes)
    assert.equal(store.bundle('solarized'), undefined, what)
    assert.deepEqual(heard, [['solarized']], what)
    assert.deepEqual(store.presence(), [], what)
    assert.ok(s.warnings.some((w) => w.includes('solarized')), what)
  }
  // Gone altogether.
  const s = setup(t)
  const store = s.make()
  store.add(pkg('solarized', 'export default 1'))
  rmSync(join(s.dir, 'solarized', 'client.js'))
  assert.equal(store.bundle('solarized'), undefined)
  assert.deepEqual(store.presence(), [])
})

test('only regular files are read: a symbolic link is not a plugin, a manifest or a bundle', { skip: posixOnly('symbolic links need no privilege') }, (t) => {
  const s = setup(t)
  const outside = join(s.dir, '..', 'outside')
  for (const id of ['linked', 'linkmanifest', 'linkclient']) writeFolder(outside, id, raw(id).manifest, 'export default {}')
  mkdirSync(s.dir, { recursive: true })
  symlinkSync(join(outside, 'linked'), join(s.dir, 'linked'))
  writeFolder(s.dir, 'linkmanifest', undefined, 'export default {}')
  symlinkSync(join(outside, 'linkmanifest', 'manifest.json'), join(s.dir, 'linkmanifest', 'manifest.json'))
  writeFolder(s.dir, 'linkclient', raw('linkclient').manifest)
  symlinkSync(join(outside, 'linkclient', 'client.js'), join(s.dir, 'linkclient', 'client.js'))
  symlinkSync(join(outside, 'linked'), join(s.dir, '.hidden-link'))
  const good = raw('good')
  writeFolder(s.dir, 'good', good.manifest, good.client)
  const store = s.make()
  assert.deepEqual(store.list().map((p) => p.manifest.id), ['good'])
  assert.ok(s.warnings.some((w) => /installed plugin linked not listed: .*symbolic link/.test(w)), JSON.stringify(s.warnings))
  assert.ok(s.warnings.some((w) => /installed plugin linkmanifest not listed: .*manifest\.json is not a regular file/.test(w)), JSON.stringify(s.warnings))
  assert.ok(s.warnings.some((w) => /installed plugin linkclient not listed: .*client\.js is not a regular file/.test(w)), JSON.stringify(s.warnings))
  assert.ok(!s.warnings.some((w) => w.includes('.hidden-link')))

  // A bundle swapped for a link to the same text: the hash still matches, and it is still not handed out.
  rmSync(join(s.dir, 'good', 'client.js'))
  writeFileSync(join(outside, 'same.js'), good.client)
  symlinkSync(join(outside, 'same.js'), join(s.dir, 'good', 'client.js'))
  assert.equal(store.bundle('good'), undefined)
  assert.deepEqual(store.list(), [])
})

test('a manifest.json or client.js that is a folder is not read', (t) => {
  const s = setup(t)
  writeFolder(s.dir, 'dirmanifest', undefined, 'export default {}')
  mkdirSync(join(s.dir, 'dirmanifest', 'manifest.json'))
  writeFolder(s.dir, 'dirclient', raw('dirclient').manifest)
  mkdirSync(join(s.dir, 'dirclient', 'client.js'))
  assert.deepEqual(s.make().list(), [])
  assert.ok(s.warnings.some((w) => /dirmanifest not listed: .*manifest\.json is not a regular file/.test(w)), JSON.stringify(s.warnings))
  assert.ok(s.warnings.some((w) => /dirclient not listed: .*client\.js is not a regular file/.test(w)), JSON.stringify(s.warnings))
})

test('staging folders left behind are swept when the store is made, once they are ten minutes old', (t) => {
  const s = setup(t)
  const before = new Date(Date.now() - 11 * 60_000)
  for (const name of ['.tmp-solarized-aaaaaaaaaaaa', '.old-solarized-bbbbbbbbbbbb', '.tmp-nord-cccccccccccc', '.old-nord-dddddddddddd', '.other-eeeeeeeeeeee']) writeFolder(s.dir, name, raw('x').manifest, 'x')
  for (const name of ['.tmp-solarized-aaaaaaaaaaaa', '.old-solarized-bbbbbbbbbbbb', '.other-eeeeeeeeeeee']) utimesSync(join(s.dir, name), before, before)
  writeFileSync(join(s.dir, '.tmp-a-file'), 'x')
  utimesSync(join(s.dir, '.tmp-a-file'), before, before)
  const store = s.make()
  assert.deepEqual(readdirSync(s.dir).sort(), ['.old-nord-dddddddddddd', '.other-eeeeeeeeeeee', '.tmp-a-file', '.tmp-nord-cccccccccccc'], 'the fresh ones may be an install running now; what is not a staging folder is not ours')
  assert.deepEqual(store.list(), [])
  assert.deepEqual(s.warnings, [])
})

test('the largest manifest that may be installed is still listed after a rescan', (t) => {
  const s = setup(t)
  const store = s.make()
  const largest = pkg('a'.repeat(32), 'export default {}', { name: '日'.repeat(64), description: '本'.repeat(300), version: `1.0.0-${'a'.repeat(58)}` })
  assert.ok(largest, 'accepted')
  store.add(largest)
  assert.equal(store.rescan(), false, 'read back the same')
  assert.deepEqual(store.list().map((p) => p.manifest), [largest.manifest])
  assert.deepEqual(s.make().list().map((p) => p.manifest), [largest.manifest])
  assert.deepEqual(s.warnings, [])
})

test('a changed name or description is a change, with the same bundle and version', (t) => {
  const s = setup(t)
  const store = s.make()
  const heard = []
  store.onChange((ids) => heard.push(ids))
  store.add(pkg('solarized'))
  store.add(pkg('solarized', undefined, { name: 'Solarized Dark' }))
  assert.equal(heard.length, 2, 'a new name is announced')
  store.add(pkg('solarized', undefined, { name: 'Solarized Dark', description: 'Darker.' }))
  assert.equal(heard.length, 3, 'a new description is announced')
  // And one another process made.
  const manifestPath = join(s.dir, 'solarized', 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), name: 'Renamed' }))
  assert.equal(store.rescan(), true)
  assert.equal(store.presence()[0].name, 'Renamed')
  assert.equal(heard.length, 4)
})

test('a listener that throws does not fail the change, stop the listeners after it, or throw from a rescan', (t) => {
  const s = setup(t)
  const store = s.make()
  const heard = []
  store.onChange(() => { throw new Error('listener broke') })
  store.onChange((ids) => heard.push(ids))
  assert.equal(store.add(pkg('solarized')).manifest.id, 'solarized')
  assert.deepEqual(store.list().map((p) => p.manifest.id), ['solarized'])
  assert.equal(store.remove('solarized'), true)
  s.make().add(pkg('nord'))
  assert.equal(store.rescan(), true)
  assert.deepEqual(heard, [['solarized'], ['solarized'], ['nord']])
  assert.equal(s.warnings.filter((w) => w.includes('listener broke')).length, 3, JSON.stringify(s.warnings))
})

test('a folder that is not listed is warned about once, and again when its reason changes', (t) => {
  const s = setup(t)
  writeFolder(s.dir, 'badjson', '{', 'export default {}')
  writeFolder(s.dir, 'noclient', raw('noclient').manifest)
  const store = s.make()
  const about = (name) => s.warnings.filter((w) => w.includes(name)).length
  assert.deepEqual([about('badjson'), about('noclient')], [1, 1])
  store.rescan()
  store.add(pkg('solarized'))
  store.rescan()
  assert.deepEqual([about('badjson'), about('noclient')], [1, 1], 'not repeated by each rescan')
  writeFolder(s.dir, 'badjson', raw('other').manifest)
  store.rescan()
  assert.deepEqual([about('badjson'), about('noclient')], [2, 1], 'a new reason is a new warning')
  // Mended, then broken the same way again: said again.
  writeFolder(s.dir, 'noclient', undefined, 'export default {}')
  assert.equal(store.rescan(), true)
  rmSync(join(s.dir, 'noclient', 'client.js'))
  assert.equal(store.rescan(), true)
  assert.equal(about('noclient'), 2)
})

test('the names Windows keeps for devices are reserved: they cannot be folders there', () => {
  const reserved = installedIdReserved([])
  for (const id of ['con', 'prn', 'aux', 'nul', 'com1', 'com5', 'com9', 'lpt1', 'lpt4', 'lpt9']) assert.equal(reserved(id), true, id)
  for (const id of ['console', 'com', 'com10', 'lpt', 'null', 'solarized']) assert.equal(reserved(id), false, id)
})
