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

/** A fetch that answers from a table of url → { status, headers, body }, and records what it was asked. */
function fakeFetch(table) {
  const asked = []
  const fetch = async (url, init) => {
    asked.push([String(url), init?.redirect])
    const entry = table[String(url)]
    if (!entry) throw new Error(`unexpected fetch of ${url}`)
    return new Response(entry.status >= 300 && entry.status < 400 ? null : (entry.body ?? ''), { status: entry.status ?? 200, headers: entry.headers ?? {} })
  }
  return { fetch, asked }
}
const rejects = (promise, pattern) => assert.rejects(promise, (err) => err.code === 'BAD_REQUEST' && pattern.test(err.message))

test('parsePluginPackageText: a package, or BAD_REQUEST with the reason', () => {
  assert.deepEqual(parsePluginPackageText(TEXT), { manifest: STORED, client: 'export default {}' })
  assert.throws(() => parsePluginPackageText('{'), (err) => err.code === 'BAD_REQUEST' && /not JSON/.test(err.message))
  assert.throws(() => parsePluginPackageText(JSON.stringify({ manifest: { ...MANIFEST, type: 'x' }, client: 'y' })), (err) => err.code === 'BAD_REQUEST' && /type must be "theme"/.test(err.message))
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
