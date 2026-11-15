// scripts/serverPluginSource.test.mjs — where a plugin package comes from (theme plugins phase 1):
// a folder, a .trekplugin file, or an https URL (https only, redirects included, size capped).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_PACKAGE_BYTES, fetchPluginPackage, parsePluginPackageText, readPluginSource } from '../server/src/plugins/source.ts'
import { removeDir } from './testPlatform.mjs'

const MANIFEST = { id: 'solarized', version: '1.0.0', name: 'Solarized', description: 'A theme.', type: 'theme', contract: 1 }
const TEXT = JSON.stringify({ manifest: MANIFEST, client: 'export default {}' })
const STORED = { ...MANIFEST, defaultEnabled: false }

/**
 * A fetch that answers from a table of url → { status, headers, body, error }, and records what it
 * was asked. As the real one, it gives up when `init.signal` aborts; a `body` that is a function
 * is called with the signal and returns the stream; an `error` is what the fetch rejects with.
 */
function fakeFetch(table) {
  const asked = []
  const fetch = async (url, init) => {
    asked.push([String(url), init?.redirect])
    init?.signal?.throwIfAborted()
    const entry = table[String(url)]
    if (!entry) throw new Error(`unexpected fetch of ${url}`)
    if (entry.error) throw entry.error
    if (entry.never) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
    const body = typeof entry.body === 'function' ? entry.body(init?.signal) : (entry.body ?? '')
    return new Response(entry.status >= 300 && entry.status < 400 ? null : body, { status: entry.status ?? 200, headers: entry.headers ?? {} })
  }
  return { fetch, asked }
}
const bytesOf = (text) => new TextEncoder().encode(text)
/** Rejects with BAD_REQUEST and a message that matches; resolves to the message. */
const rejects = async (promise, pattern) => {
  let message
  await assert.rejects(promise, (err) => {
    message = err.message
    assert.equal(err.code, 'BAD_REQUEST', `${err.name}: ${err.message}`)
    assert.match(err.message, pattern)
    return true
  })
  return message
}

test('parsePluginPackageText: a package, or BAD_REQUEST with the reason', () => {
  assert.deepEqual(parsePluginPackageText(TEXT), { manifest: STORED, client: 'export default {}' })
  assert.throws(() => parsePluginPackageText('{'), (err) => err.code === 'BAD_REQUEST' && /not JSON/.test(err.message))
  assert.throws(() => parsePluginPackageText(JSON.stringify({ manifest: { ...MANIFEST, type: 'x' }, client: 'y' })), (err) => err.code === 'BAD_REQUEST' && /type must be "theme"/.test(err.message))
})

test('parsePluginPackageText: text longer than a package may be is refused before it is parsed', (t) => {
  const parse = t.mock.method(JSON, 'parse')
  // Well formed, and a fine package but for its size: it would be taken if it were parsed.
  const padded = JSON.stringify({ manifest: MANIFEST, client: 'export default {}', padding: 'x'.repeat(MAX_PACKAGE_BYTES) })
  for (const text of ['x'.repeat(MAX_PACKAGE_BYTES + 1), padded]) {
    assert.throws(() => parsePluginPackageText(text), (err) => err.code === 'BAD_REQUEST' && /larger than a plugin package may be/.test(err.message))
  }
  assert.equal(parse.mock.callCount(), 0)
})

test('readPluginSource: a folder with manifest.json and client.js, or a .trekplugin file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-plugin-source-'))
  t.after(() => removeDir(dir))
  mkdirSync(join(dir, 'theme'))
  writeFileSync(join(dir, 'theme', 'manifest.json'), JSON.stringify(MANIFEST))
  writeFileSync(join(dir, 'theme', 'client.js'), 'export default {}')
  writeFileSync(join(dir, 'solarized.trekplugin'), TEXT)
  mkdirSync(join(dir, 'empty'))
  const { fetch } = fakeFetch({})
  assert.deepEqual(await readPluginSource(join(dir, 'theme'), fetch), { manifest: STORED, client: 'export default {}' })
  assert.deepEqual(await readPluginSource(join(dir, 'solarized.trekplugin'), fetch), { manifest: STORED, client: 'export default {}' })
  await rejects(readPluginSource(join(dir, 'empty'), fetch), /manifest\.json/)
  await rejects(readPluginSource(join(dir, 'missing.trekplugin'), fetch), /cannot be read/)
})

test('readPluginSource: a byte-order mark is not part of the text, and what is not UTF-8 is refused', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-plugin-source-'))
  t.after(() => removeDir(dir))
  const { fetch } = fakeFetch({})
  mkdirSync(join(dir, 'theme'))
  writeFileSync(join(dir, 'theme', 'manifest.json'), `\uFEFF${JSON.stringify(MANIFEST)}`)
  writeFileSync(join(dir, 'theme', 'client.js'), '\uFEFFexport default {}')
  writeFileSync(join(dir, 'solarized.trekplugin'), `\uFEFF${TEXT}`)
  assert.deepEqual(await readPluginSource(join(dir, 'theme'), fetch), { manifest: STORED, client: 'export default {}' }, 'the bundle that is stored has no mark')
  assert.deepEqual(await readPluginSource(join(dir, 'solarized.trekplugin'), fetch), { manifest: STORED, client: 'export default {}' })

  const latin1 = Buffer.from('export default "caf\xe9"', 'latin1')
  mkdirSync(join(dir, 'badclient'))
  writeFileSync(join(dir, 'badclient', 'manifest.json'), JSON.stringify(MANIFEST))
  writeFileSync(join(dir, 'badclient', 'client.js'), latin1)
  await rejects(readPluginSource(join(dir, 'badclient'), fetch), /client\.js is not UTF-8 text/)
  mkdirSync(join(dir, 'badmanifest'))
  writeFileSync(join(dir, 'badmanifest', 'manifest.json'), Buffer.from(JSON.stringify({ ...MANIFEST, name: 'Caf\xe9' }), 'latin1'))
  writeFileSync(join(dir, 'badmanifest', 'client.js'), 'export default {}')
  await rejects(readPluginSource(join(dir, 'badmanifest'), fetch), /manifest\.json is not UTF-8 text/)
  writeFileSync(join(dir, 'bad.trekplugin'), Buffer.from(JSON.stringify({ manifest: MANIFEST, client: 'export default "caf\xe9"' }), 'latin1'))
  await rejects(readPluginSource(join(dir, 'bad.trekplugin'), fetch), /bad\.trekplugin is not UTF-8 text/)
})

test('a URL: https only, also after a redirect, and at most five redirects', async () => {
  const ok = fakeFetch({
    'https://a.test/p': { status: 302, headers: { location: '/q' } },
    'https://a.test/q': { status: 301, headers: { location: 'https://b.test/solarized.trekplugin' } },
    'https://b.test/solarized.trekplugin': { status: 200, body: TEXT }
  })
  assert.deepEqual(await readPluginSource('https://a.test/p', ok.fetch), { manifest: STORED, client: 'export default {}' })
  assert.deepEqual(ok.asked.map(([url, redirect]) => [url, redirect]), [['https://a.test/p', 'manual'], ['https://a.test/q', 'manual'], ['https://b.test/solarized.trekplugin', 'manual']])

  await rejects(fetchPluginPackage('http://a.test/p', ok.fetch), /https/)
  await rejects(fetchPluginPackage('ftp://a.test/p', ok.fetch), /https/)
  await rejects(fetchPluginPackage('not a url', ok.fetch), /https/)
  const down = fakeFetch({ 'https://a.test/p': { status: 302, headers: { location: 'http://a.test/p' } } })
  await rejects(fetchPluginPackage('https://a.test/p', down.fetch), /redirects to a URL that is not https/)
  const loop = fakeFetch({ 'https://a.test/p': { status: 302, headers: { location: 'https://a.test/p' } } })
  await rejects(fetchPluginPackage('https://a.test/p', loop.fetch), /too many redirects/)
  assert.equal(loop.asked.length, 6)
  const gone = fakeFetch({ 'https://a.test/p': { status: 404 } })
  await rejects(fetchPluginPackage('https://a.test/p', gone.fetch), /HTTP 404/)
})

test('a URL: a body larger than the cap is not read to the end', async () => {
  const declared = fakeFetch({ 'https://a.test/p': { status: 200, headers: { 'content-length': String(MAX_PACKAGE_BYTES + 1) }, body: 'x' } })
  await rejects(fetchPluginPackage('https://a.test/p', declared.fetch), /larger than/)
  const undeclared = fakeFetch({ 'https://a.test/p': { status: 200, body: 'x'.repeat(MAX_PACKAGE_BYTES + 1) } })
  await rejects(fetchPluginPackage('https://a.test/p', undeclared.fetch), /larger than/)
})

test('a URL: a body in several chunks is read no further than the cap, and the stream is cancelled', async () => {
  const CHUNK = 64 * 1024
  const chunk = new Uint8Array(CHUNK).fill(0x78)
  const enough = Math.ceil(MAX_PACKAGE_BYTES / CHUNK) + 1
  let pulls = 0
  let cancelled = false
  const endless = fakeFetch({
    'https://a.test/p': {
      // It never ends: a reader that drained it would not come back.
      body: () => new ReadableStream({ pull: (controller) => { pulls++; controller.enqueue(chunk) }, cancel: () => { cancelled = true } })
    }
  })
  await rejects(fetchPluginPackage('https://a.test/p', endless.fetch), /https:\/\/a\.test\/p is larger than a plugin package may be/)
  assert.ok(pulls >= enough && pulls <= enough + 3, `${pulls} chunks pulled for a cap of ${enough}`)
  assert.equal(cancelled, true)
})

test('a URL: a body that stalls or breaks is BAD_REQUEST with the URL, as a fetch that never answers is', async (t) => {
  // AbortSignal.timeout's timer does not keep the process alive, and a fake fetch holds no socket that would.
  const alive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(alive))
  const stalled = fakeFetch({
    'https://a.test/p': {
      body: (signal) => new ReadableStream({
        start(controller) {
          controller.enqueue(bytesOf('{"manifest":'))
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        }
      })
    }
  })
  await rejects(fetchPluginPackage('https://a.test/p', stalled.fetch, 50), /^Could not read https:\/\/a\.test\/p: .*timeout/i)

  let pulls = 0
  const broken = fakeFetch({
    'https://a.test/p': {
      body: () => new ReadableStream({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(bytesOf('{"manifest":'))
          else controller.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }))
        }
      })
    }
  })
  await rejects(fetchPluginPackage('https://a.test/p', broken.fetch), /^Could not read https:\/\/a\.test\/p: terminated \(UND_ERR_SOCKET\)$/)

  const silent = fakeFetch({ 'https://a.test/p': { never: true } })
  await rejects(fetchPluginPackage('https://a.test/p', silent.fetch, 50), /^Could not read https:\/\/a\.test\/p: .*timeout/i)
})

test("a URL: a failed fetch says why (Node's reason is in the error's cause)", async () => {
  const failed = (cause) => fakeFetch({ 'https://a.test/p': { error: Object.assign(new TypeError('fetch failed'), cause === undefined ? {} : { cause }) } }).fetch
  await rejects(fetchPluginPackage('https://a.test/p', failed(Object.assign(new Error('getaddrinfo ENOTFOUND a.test'), { code: 'ENOTFOUND' }))), /^Could not read https:\/\/a\.test\/p: fetch failed \(ENOTFOUND\)$/)
  await rejects(fetchPluginPackage('https://a.test/p', failed(new Error('unable to verify the first certificate'))), /^Could not read https:\/\/a\.test\/p: fetch failed \(unable to verify the first certificate\)$/)
  await rejects(fetchPluginPackage('https://a.test/p', failed(undefined)), /^Could not read https:\/\/a\.test\/p: fetch failed$/)
  await rejects(fetchPluginPackage('https://a.test/p', failed('odd')), /^Could not read https:\/\/a\.test\/p: fetch failed$/)
})

test('a URL: a redirect with no location is refused at once', async () => {
  for (const status of [302, 304, 300, 399]) {
    const nowhere = fakeFetch({ 'https://a.test/p': { status } })
    await rejects(fetchPluginPackage('https://a.test/p', nowhere.fetch), new RegExp(`^Could not read https://a\\.test/p: HTTP ${status} with no location$`))
    assert.equal(nowhere.asked.length, 1, `${status}: asked once`)
  }
  const after = fakeFetch({ 'https://a.test/p': { status: 302, headers: { location: '/q' } }, 'https://a.test/q': { status: 307 } })
  await rejects(fetchPluginPackage('https://a.test/p', after.fetch), /^Could not read https:\/\/a\.test\/q: HTTP 307 with no location$/)
  assert.equal(after.asked.length, 2)
})

test('a URL with a user name or password is refused, and no message carries credentials, a query or a fragment', async () => {
  const messages = []
  const none = fakeFetch({})
  for (const source of ['https://user:hunter2@a.test/p', 'https://user@a.test/p', 'https://:hunter2@a.test/p?key=sekrit#frag']) {
    messages.push(await rejects(fetchPluginPackage(source, none.fetch), /user name or password/))
  }
  assert.equal(none.asked.length, 0, 'never fetched')
  messages.push(await rejects(fetchPluginPackage('http://user:hunter2@a.test/p?key=sekrit', none.fetch), /https/))
  messages.push(await rejects(fetchPluginPackage('https://user:hunter2@/?key=sekrit', none.fetch), /https/))

  const hop = fakeFetch({ 'https://a.test/p?key=sekrit': { status: 302, headers: { location: 'https://user:hunter2@b.test/q?key=sekrit' } } })
  messages.push(await rejects(fetchPluginPackage('https://a.test/p?key=sekrit', hop.fetch), /redirects to a URL with a user name or password/))
  assert.equal(hop.asked.length, 1, 'the redirect was not followed')

  // Each way a fetch of a URL with a query can fail.
  const table = {
    'https://a.test/gone?key=sekrit#frag': { status: 404 },
    'https://a.test/down?key=sekrit': { status: 302, headers: { location: 'http://a.test/x?key=sekrit' } },
    'https://a.test/loop?key=sekrit': { status: 302, headers: { location: 'https://a.test/loop?key=sekrit' } },
    'https://a.test/nowhere?key=sekrit': { status: 302 },
    'https://a.test/big?key=sekrit': { status: 200, headers: { 'content-length': String(MAX_PACKAGE_BYTES + 1) }, body: 'x' },
    'https://a.test/bytes?key=sekrit': { status: 200, body: Buffer.from([0x7b, 0xff, 0xfe]) },
    'https://a.test/failed?key=sekrit': { error: new TypeError('fetch failed') },
    'https://a.test/text?key=sekrit': { status: 200, body: 'not json' }
  }
  for (const source of Object.keys(table)) {
    const { fetch } = fakeFetch({ ...table, 'https://a.test/gone?key=sekrit': table['https://a.test/gone?key=sekrit#frag'] })
    messages.push(await rejects(fetchPluginPackage(source, fetch), /./))
  }
  assert.equal(messages.length, 14)
  for (const message of messages) assert.doesNotMatch(message, /hunter2|user(?! name or password)|sekrit|frag|[?#@]/, message)
  assert.ok(messages.some((m) => m.includes('https://a.test/gone: HTTP 404')), 'the URL is still named, without them')
})

test('a URL: a byte-order mark is not part of the text, and a body that is not UTF-8 is refused', async () => {
  const marked = fakeFetch({ 'https://a.test/p': { status: 200, body: `﻿${TEXT}` } })
  assert.deepEqual(await fetchPluginPackage('https://a.test/p', marked.fetch), { manifest: STORED, client: 'export default {}' })
  const latin1 = fakeFetch({ 'https://a.test/p': { status: 200, body: Buffer.from(JSON.stringify({ manifest: MANIFEST, client: 'export default "caf\xe9"' }), 'latin1') } })
  await rejects(fetchPluginPackage('https://a.test/p', latin1.fetch), /^https:\/\/a\.test\/p is not UTF-8 text$/)
  // Cut in the middle of a character, across two chunks: still one text.
  const euro = bytesOf(JSON.stringify({ manifest: MANIFEST, client: 'export default "€"' }))
  const cut = euro.indexOf(0xe2) + 1
  const split = fakeFetch({
    'https://a.test/p': {
      body: () => new ReadableStream({ start(controller) { controller.enqueue(euro.slice(0, cut)); controller.enqueue(euro.slice(cut)); controller.close() } })
    }
  })
  assert.equal((await fetchPluginPackage('https://a.test/p', split.fetch)).client, 'export default "€"')
})
