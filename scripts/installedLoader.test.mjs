// scripts/installedLoader.test.mjs — the installed-plugin loader (theme plugins phase 2): the
// bundle from plugins.bundle, hashed exactly as received, imported, and its default export checked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadInstalledPlugin, sha256Hex } from '../src/renderer/src/plugins/installedLoader.ts'

const bundleOf = (id = 'nord', version = '1.0.0') =>
  `export default { manifest: { id: ${JSON.stringify(id)}, version: ${JSON.stringify(version)}, name: 'N', description: 'D', defaultEnabled: false, type: 'theme', contract: 1 }, theme: { styles: ':root{--bg:#000}' } }\n`

/**
 * Node cannot import a blob: URL; a data: URL stands in for it. As the window does, the text is
 * imported through a second module that re-exports its namespace as `ns`.
 */
const dataUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
const importText = (text) => import(dataUrl(`export * as ns from ${JSON.stringify(dataUrl(text))}`))

async function fixture(client = bundleOf(), over = {}) {
  const sha256 = await sha256Hex(client)
  const theme = { id: 'nord', version: '1.0.0', name: 'Nord', description: '', sha256, contract: 1, ...over }
  const calls = []
  const imported = []
  const deps = {
    cache: new Map(),
    request: async (method, params) => {
      calls.push([method, params])
      return { sha256, client }
    },
    importText: (text) => {
      imported.push(text)
      return importText(text)
    }
  }
  return { theme, sha256, client, deps, calls, imported }
}

test('sha256Hex hashes the UTF-8 bytes of exactly the string given', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.notEqual(await sha256Hex('abc\n'), await sha256Hex('abc'))
  assert.notEqual(await sha256Hex('\uFEFFabc'), await sha256Hex('abc'), 'a BOM is part of the text')
})

test('a bundle that matches loads; its text is imported with a sourceURL after hashing; a second load is from memory', async () => {
  const f = await fixture()
  const result = await loadInstalledPlugin(f.theme, f.sha256, f.deps)
  assert.equal(result.kind, 'loaded')
  assert.equal(result.plugin.manifest.id, 'nord')
  assert.equal(result.plugin.theme.styles, ':root{--bg:#000}')
  assert.deepEqual(f.calls, [['plugins.bundle', { id: 'nord' }]])
  assert.equal(f.imported[0], `${f.client}\n//# sourceURL=trek-plugin/nord/client.js`)
  const again = await loadInstalledPlugin(f.theme, f.sha256, f.deps)
  assert.equal(again.kind, 'loaded')
  assert.equal(again.plugin, result.plugin)
  assert.equal(f.calls.length, 1, 'no second request')
})

test('a hash the user did not accept, or another plugin contract, stops before any request', async () => {
  const f = await fixture()
  assert.deepEqual(await loadInstalledPlugin(f.theme, 'b'.repeat(64), f.deps), { kind: 'failed', reason: 'its bundle is not the one accepted in this app' })
  assert.deepEqual(await loadInstalledPlugin({ ...f.theme, contract: 2 }, f.sha256, f.deps), {
    kind: 'failed',
    reason: "it was built for another version of Trek's plugin contract"
  })
  assert.deepEqual(f.calls, [])
})

test('stale: NOT_FOUND, or a bundle whose hash is no longer the listed one', async () => {
  const f = await fixture()
  f.deps.request = async () => {
    throw Object.assign(new Error('No installed plugin has the id'), { code: 'NOT_FOUND' })
  }
  assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'stale' })
  const newer = bundleOf('nord', '1.0.1')
  f.deps.request = async () => ({ sha256: await sha256Hex(newer), client: newer })
  assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'stale' })
  assert.deepEqual(f.imported, [], 'nothing imported')
})

test('failed: the request fails, a bad answer, text that does not match its hash, an import that throws', async () => {
  const f = await fixture()
  f.deps.request = async () => {
    throw Object.assign(new Error('not connected to the server'), { code: 'NOT_CONNECTED' })
  }
  assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'failed', reason: 'the server did not send it (not connected to the server)' })
  f.deps.request = async () => ({ sha256: f.sha256 })
  assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'failed', reason: 'the server sent no bundle' })
  f.deps.request = async () => ({ sha256: f.sha256, client: `${f.client} ` })
  assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'failed', reason: 'the bundle does not match its hash' })
  assert.deepEqual(f.imported, [], 'never imported')
  const broken = await fixture('export default {')
  const result = await loadInstalledPlugin(broken.theme, broken.sha256, broken.deps)
  assert.equal(result.kind, 'failed')
  assert.match(result.reason, /^its code could not be loaded \(/)
})

test('failed: a default export that is not this plugin', async () => {
  for (const [client, reason] of [
    ['export const x = 1\n', 'its bundle has no plugin as its default export'],
    ['export default 3\n', 'its bundle has no plugin as its default export'],
    [bundleOf('gruv'), 'its bundle is another plugin (gruv 1.0.0)'],
    [bundleOf('nord', '2.0.0'), 'its bundle is another plugin (nord 2.0.0)']
  ]) {
    const f = await fixture(client)
    assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'failed', reason }, client)
    assert.equal(f.deps.cache.size, 0, 'a bad bundle is not kept')
  }
})

test('a default export of an odd shape fails with a reason: it never rejects', async () => {
  for (const [client, reason] of [
    ["export default { manifest: { id: Object.create(null), version: '1.0.0' } }\n", 'its bundle is another plugin (? 1.0.0)'],
    ["export default { manifest: { id: 'nord', version: { toString() { throw new Error('boom') } } } }\n", 'its bundle is another plugin (nord ?)'],
    ["export default { get manifest() { throw new Error('boom') } }\n", 'its bundle could not be read (boom)'],
    ['export default { get manifest() { throw Object.create(null) } }\n', 'its bundle could not be read (an error with no message)'],
    ['export default null\n', 'its bundle has no plugin as its default export'],
    [bundleOf('g'.repeat(500)), `its bundle is another plugin (${'g'.repeat(79)}… 1.0.0)`]
  ]) {
    const f = await fixture(client)
    assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'failed', reason }, client)
    assert.equal(f.deps.cache.size, 0)
  }
})

test('a then export is not followed: the load fails at once, with a reason', async () => {
  const f = await fixture(`export function then() {}\n${bundleOf()}`)
  f.deps.timeoutMs = 60_000
  const started = Date.now()
  assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'failed', reason: 'its bundle exports a "then", which a plugin may not' })
  assert.ok(Date.now() - started < 30_000, 'not by the time limit')
  assert.equal(f.deps.cache.size, 0)
})

test('a bundle that never finishes loading fails after the time limit, and the timer is cleared otherwise', async () => {
  const hung = await fixture(`await new Promise(() => {})\n${bundleOf()}`)
  hung.deps.timeoutMs = 50
  assert.deepEqual(await loadInstalledPlugin(hung.theme, hung.sha256, hung.deps), { kind: 'failed', reason: 'its code did not finish loading' })
  // An importer that follows a then export (or never answers) is cut off the same way.
  const followed = await fixture(`export function then() {}\n${bundleOf()}`)
  followed.deps.timeoutMs = 50
  followed.deps.importText = (text) => import(dataUrl(text))
  assert.deepEqual(await loadInstalledPlugin(followed.theme, followed.sha256, followed.deps), { kind: 'failed', reason: 'its code did not finish loading' })
  // A load that settles leaves no timer behind: with one, this test file would not end for an hour.
  const fine = await fixture()
  fine.deps.timeoutMs = 3_600_000
  assert.equal((await loadInstalledPlugin(fine.theme, fine.sha256, fine.deps)).kind, 'loaded')
  const broken = await fixture('export default {')
  broken.deps.timeoutMs = 3_600_000
  assert.equal((await loadInstalledPlugin(broken.theme, broken.sha256, broken.deps)).kind, 'failed')
})

test('failed, not rejected: no crypto.subtle, an importer that throws, a request that throws something odd', async () => {
  const f = await fixture()
  const own = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
  try {
    assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'failed', reason: 'this page cannot check a bundle (no SHA-256 here)' })
  } finally {
    if (own) Object.defineProperty(globalThis, 'crypto', own)
    else delete globalThis.crypto
  }
  assert.deepEqual(f.imported, [], 'an unchecked bundle is never imported')
  f.deps.importText = () => {
    throw new Error('no importer')
  }
  assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'failed', reason: 'its code could not be loaded (no importer)' })
  f.deps.request = () => {
    throw Object.create(null)
  }
  assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'failed', reason: 'the server did not send it (an error with no message)' })
  f.deps.request = async () => {
    throw new Error('x'.repeat(5000))
  }
  const long = await loadInstalledPlugin(f.theme, f.sha256, f.deps)
  assert.equal(long.kind, 'failed')
  assert.ok(long.reason.length < 300, `a long message is cut (${long.reason.length})`)
  assert.match(long.reason, /^the server did not send it \(x+…\)$/)
})

test('an id that is not a plugin id is refused before any request', async () => {
  for (const id of ['nord\n//# sourceMappingURL=https://example.invalid/x', '../nord', 'Nord', '', 7]) {
    const f = await fixture(bundleOf(), { id })
    assert.deepEqual(await loadInstalledPlugin(f.theme, f.sha256, f.deps), { kind: 'failed', reason: 'its id is not a plugin id' }, String(id))
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.imported, [])
  }
})

test('the same bundle listed under another id, or another version, is not served from memory', async () => {
  const f = await fixture()
  assert.equal((await loadInstalledPlugin(f.theme, f.sha256, f.deps)).kind, 'loaded')
  assert.equal(f.deps.cache.size, 1)
  assert.deepEqual(await loadInstalledPlugin({ ...f.theme, id: 'gruv' }, f.sha256, f.deps), { kind: 'failed', reason: 'its bundle is another plugin (nord 1.0.0)' })
  assert.deepEqual(await loadInstalledPlugin({ ...f.theme, version: '1.0.1' }, f.sha256, f.deps), { kind: 'failed', reason: 'its bundle is another plugin (nord 1.0.0)' })
  assert.deepEqual(f.calls, [['plugins.bundle', { id: 'nord' }], ['plugins.bundle', { id: 'gruv' }], ['plugins.bundle', { id: 'nord' }]], 'each asked the server again')
  const again = await loadInstalledPlugin(f.theme, f.sha256, f.deps)
  assert.equal(again.kind, 'loaded')
  assert.equal(f.calls.length, 3, 'the listed one is still in memory')
})

test("both pages' content security policies allow a blob: script, and nothing looser", () => {
  for (const page of ['src/renderer/index.html', 'src/web/index.html']) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8')
    assert.ok(html.includes("script-src 'self' blob:;"), page)
    assert.equal(/script-src[^;]*unsafe/.test(html), false, page)
  }
})
