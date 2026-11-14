// scripts/serverUpdateFeed.test.mjs — the update feed: SHA256SUMS parsed and its Ed25519 signature
// verified against the built-in keys, then this target's tarball and version read from it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { MAX_FEED_BYTES, fetchRelease, parseSums, releaseFor, tarballUrl, verifySums } from '../server/src/update/feed.ts'
import { UPDATE_FEED, UPDATE_PUBLIC_KEYS, updateSource } from '../server/src/update/keys.ts'

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pem: publicKey.export({ type: 'spki', format: 'pem' }), privateKey }
}
const A = pair()
const B = pair()
const H = (c) => c.repeat(64)
const SUMS = [
  `${H('a')}  Trek-0.5.0-arm64.dmg`,
  `${H('b')}  trek-server-0.5.0-darwin-arm64.tar.gz`,
  `${H('c')}  trek-server-0.5.0-linux-x64.tar.gz`,
  `${H('d')} *trek-server-0.5.0-linux-arm64.tar.gz`,
  `${H('e')}  trek-server-0.5.0-win32-x64.zip`,
  ''
].join('\n')
const sigOf = (text, key) => sign(null, Buffer.from(text), key.privateKey).toString('base64')

test('parseSums reads sha256sum lines, text or binary mode, and ignores the rest', () => {
  const sums = parseSums(SUMS + 'not a line\n' + `${H('f').slice(1)}  short-hash\n` + `${H('F')}  upper-case-hash\n` + `${H('f')}0  long-hash\n`)
  assert.equal(sums.size, 5)
  assert.equal(sums.get('trek-server-0.5.0-linux-x64.tar.gz'), H('c'))
  assert.equal(sums.get('trek-server-0.5.0-linux-arm64.tar.gz'), H('d'), 'the binary-mode star is not part of the name')
  assert.equal(parseSums(`${H('c')}  a file.tar.gz\r\n`).get('a file.tar.gz'), H('c'), 'CRLF line ends, and a name with a space')
})

test('verifySums: a signature from any listed key, over exactly these bytes', () => {
  const bytes = Buffer.from(SUMS)
  const good = sigOf(SUMS, A)
  assert.equal(verifySums(bytes, good, [A.pem]), true)
  assert.equal(verifySums(bytes, sigOf(SUMS, B), [A.pem, B.pem]), true, 'the second listed key')
  assert.equal(verifySums(bytes, sigOf(SUMS, B), [A.pem]), false, 'a key that is not listed')
  assert.equal(verifySums(Buffer.from(SUMS + ' '), good, [A.pem]), false, 'one byte more')
  assert.equal(verifySums(Buffer.from(SUMS.replace(H('c'), H('9'))), good, [A.pem]), false, 'another hash for a file')
  assert.equal(verifySums(bytes, `${good}\n`, [A.pem]), true, 'a trailing newline in the .sig file')
  assert.equal(verifySums(bytes, 'AAAA', [A.pem]), false, 'not 64 bytes')
  assert.equal(verifySums(bytes, good.slice(0, -4), [A.pem]), false, 'a truncated signature')
  assert.equal(verifySums(bytes, Buffer.alloc(64).toString('base64'), [A.pem]), false, '64 bytes that are not a signature')
  assert.equal(verifySums(bytes, '!!! not base64 !!!', [A.pem]), false, 'not base64')
  assert.equal(verifySums(bytes, '', [A.pem]), false)
  assert.equal(verifySums(bytes, good, []), false, 'no keys: nothing verifies')
  assert.equal(verifySums(bytes, good, ['not a pem']), false)
  assert.equal(verifySums(bytes, good, ['not a pem', A.pem]), true, 'a bad entry does not hide a good key after it')
})

test('releaseFor picks this target tarball and its version; stable versions only', () => {
  assert.deepEqual(releaseFor(parseSums(SUMS), 'linux-x64'), { version: '0.5.0', file: 'trek-server-0.5.0-linux-x64.tar.gz', sha256: H('c') })
  assert.deepEqual(releaseFor(parseSums(SUMS), 'linux-arm64'), { version: '0.5.0', file: 'trek-server-0.5.0-linux-arm64.tar.gz', sha256: H('d') })
  assert.equal(releaseFor(parseSums(SUMS), 'darwin-x64'), null, 'no file for the target')
  assert.equal(releaseFor(parseSums(`${H('c')}  trek-server-0.5.0-rc.1-linux-x64.tar.gz\n`), 'linux-x64'), null, 'a prerelease name')
  assert.equal(releaseFor(parseSums(`${H('c')}  trek-server-0.5.0-linux-x64.tar.gz.sha256\n`), 'linux-x64'), null)
  assert.equal(releaseFor(parseSums(`${H('c')}  dir/trek-server-0.5.0-linux-x64.tar.gz\n`), 'linux-x64'), null, 'a name with a folder')
})

test('fetchRelease: both files from <feed>/latest/download, verified before anything is read from them', async () => {
  const asked = []
  const feed = (files) => async (url) => {
    asked.push(String(url))
    const body = files[String(url).split('/').pop()]
    return body === undefined ? new Response('no', { status: 404 }) : new Response(body)
  }
  const opts = { feed: 'http://127.0.0.1:1/releases', keys: [A.pem], target: 'linux-x64' }
  const good = await fetchRelease({ ...opts, fetch: feed({ SHA256SUMS: SUMS, 'SHA256SUMS.sig': sigOf(SUMS, A) }) })
  assert.deepEqual(good, { version: '0.5.0', file: 'trek-server-0.5.0-linux-x64.tar.gz', sha256: H('c') })
  assert.deepEqual(asked, ['http://127.0.0.1:1/releases/latest/download/SHA256SUMS', 'http://127.0.0.1:1/releases/latest/download/SHA256SUMS.sig'])
  assert.equal(tarballUrl(opts.feed, good), 'http://127.0.0.1:1/releases/download/v0.5.0/trek-server-0.5.0-linux-x64.tar.gz')

  await assert.rejects(fetchRelease({ ...opts, fetch: feed({ SHA256SUMS: SUMS, 'SHA256SUMS.sig': sigOf(SUMS, B) }) }), /signature/)
  // The signature is over the published file: one whose hash was changed afterwards is refused.
  await assert.rejects(fetchRelease({ ...opts, fetch: feed({ SHA256SUMS: SUMS.replace(H('c'), H('9')), 'SHA256SUMS.sig': sigOf(SUMS, A) }) }), /signature/)
  await assert.rejects(fetchRelease({ ...opts, fetch: feed({ SHA256SUMS: SUMS }) }), /read SHA256SUMS\.sig from.*404/)
  await assert.rejects(fetchRelease({ ...opts, fetch: feed({}) }), /read SHA256SUMS from.*404/)
  asked.length = 0
  await assert.rejects(fetchRelease({ ...opts, keys: [], fetch: feed({ SHA256SUMS: SUMS, 'SHA256SUMS.sig': sigOf(SUMS, A) }) }), /no update key/)
  assert.deepEqual(asked, [], 'with no key nothing is fetched')
  await assert.rejects(fetchRelease({ ...opts, target: 'darwin-x64', fetch: feed({ SHA256SUMS: SUMS, 'SHA256SUMS.sig': sigOf(SUMS, A) }) }), /no build for darwin-x64/)
  await assert.rejects(fetchRelease({ ...opts, fetch: async () => { throw new Error('offline') } }), /offline/)
})

test('fetchRelease reads no more than 1 MB of either file', async () => {
  assert.equal(MAX_FEED_BYTES, 1024 * 1024)
  const opts = { feed: 'http://127.0.0.1:1/releases', keys: [A.pem], target: 'linux-x64' }
  const good = { SHA256SUMS: SUMS, 'SHA256SUMS.sig': sigOf(SUMS, A) }
  /** A body of `chunks` chunks of 64 KiB each, with no length declared; counts those that were read. */
  const endless = (chunks, pulled) =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (pulled.count >= chunks) return controller.close()
          pulled.count++
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x61))
        }
      })
    )
  for (const big of ['SHA256SUMS', 'SHA256SUMS.sig']) {
    const pulled = { count: 0 }
    const fetch = async (url) => {
      const name = String(url).split('/').pop()
      return name === big ? endless(1000, pulled) : new Response(good[name])
    }
    await assert.rejects(fetchRelease({ ...opts, fetch }), new RegExp(`${big.replace('.', '\\.')} .*is larger than 1 MB`))
    assert.ok(pulled.count <= 20, `the read stops at the cap: ${pulled.count} chunks of 64 KiB were taken, of 1000`)
  }
  // One that says how long it is, is refused before any of it is read.
  const pulled = { count: 0 }
  const declared = async (url) => {
    const name = String(url).split('/').pop()
    if (name !== 'SHA256SUMS') return new Response(good[name])
    const res = endless(1000, pulled)
    return new Response(res.body, { headers: { 'content-length': String(64 * 1024 * 1000) } })
  }
  await assert.rejects(fetchRelease({ ...opts, fetch: declared }), /SHA256SUMS .*is larger than 1 MB/)
  assert.equal(pulled.count <= 1, true)
  // Under the cap, in several chunks, it is read whole.
  const parts = async (url) => {
    const name = String(url).split('/').pop()
    const bytes = Buffer.from(good[name])
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes.subarray(0, 10))); c.enqueue(new Uint8Array(bytes.subarray(10))); c.close() } }))
  }
  assert.equal((await fetchRelease({ ...opts, fetch: parts })).version, '0.5.0')
})

test('fetchRelease gives each request a signal that ends it after the timeout', async () => {
  const hung = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason))
  })
  // AbortSignal.timeout's timer does not keep the process alive, and this fake holds no socket.
  const alive = setTimeout(() => {}, 10_000)
  try {
    await assert.rejects(
      fetchRelease({ feed: 'http://127.0.0.1:1/releases', keys: [A.pem], target: 'linux-x64', fetch: hung, timeoutMs: 20 }),
      { name: 'TimeoutError' }
    )
  } finally {
    clearTimeout(alive)
  }
})

test('the feed and keys are fixed, except in a test build that names both', () => {
  assert.equal(UPDATE_FEED, 'https://github.com/gettrekapp/trek/releases')
  const env = { TREK_UPDATE_FEED: 'http://127.0.0.1:9/r/', TREK_UPDATE_PUBKEY: A.pem }
  assert.deepEqual(updateSource(env, false), { feed: UPDATE_FEED, keys: UPDATE_PUBLIC_KEYS }, 'a release build ignores the environment')
  assert.deepEqual(updateSource(env, true), { feed: 'http://127.0.0.1:9/r', keys: [A.pem] })
  assert.deepEqual(updateSource({ TREK_UPDATE_FEED: 'http://127.0.0.1:9/r' }, true), { feed: UPDATE_FEED, keys: UPDATE_PUBLIC_KEYS }, 'both or neither')
  assert.deepEqual(updateSource({ TREK_UPDATE_PUBKEY: A.pem }, true), { feed: UPDATE_FEED, keys: UPDATE_PUBLIC_KEYS }, 'both or neither')
  assert.deepEqual(updateSource(env), { feed: UPDATE_FEED, keys: UPDATE_PUBLIC_KEYS }, 'run from source, this is not a test build')
  for (const pem of UPDATE_PUBLIC_KEYS) {
    assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/)
    assert.equal(createPublicKey(pem).asymmetricKeyType, 'ed25519')
  }
})
