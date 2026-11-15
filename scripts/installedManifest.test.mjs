// scripts/installedManifest.test.mjs — what may be installed as a plugin (theme plugins phase 1):
// checkPluginPackage's refusals, the manifest it stores, and the welcome's extra presence fields.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PLUGIN_CLIENT_BYTES, PLUGIN_CONTRACT_VERSION, checkPluginPackage, parsePluginPresence } from '../src/shared/plugins/manifest.ts'

const MANIFEST = { id: 'solarized', version: '1.0.0', name: 'Solarized', description: 'A calm theme.', type: 'theme', contract: 1 }
const pkg = (manifest = {}, client = 'export default {}') => ({ manifest: { ...MANIFEST, ...manifest }, client })
const problem = (raw) => checkPluginPackage(raw).problem

test('a well-formed theme package is accepted, and its manifest is stored with only the known fields', () => {
  const checked = checkPluginPackage(pkg({ defaultEnabled: true, somethingElse: 1 }))
  assert.equal(checked.problem, undefined)
  assert.deepEqual(checked.package.manifest, { ...MANIFEST, defaultEnabled: false })
  assert.equal(checked.package.client, 'export default {}')
  assert.equal(PLUGIN_CONTRACT_VERSION, 1)
})

test('each bad field is refused with its reason', () => {
  assert.match(problem(null), /must be an object/)
  assert.match(problem({ manifest: MANIFEST }), /client must be a non-empty string/)
  assert.match(problem({ manifest: 'x', client: 'y' }), /manifest must be an object/)
  assert.match(problem(pkg({ id: '../x' })), /not a plugin id/)
  assert.match(problem(pkg({ id: 'Solarized' })), /not a plugin id/)
  assert.match(problem(pkg({ version: '1.0' })), /version/)
  assert.match(problem(pkg({ name: '' })), /name/)
  assert.match(problem(pkg({ name: 'x'.repeat(65) })), /name/)
  assert.match(problem(pkg({ description: '' })), /description/)
  assert.match(problem(pkg({ description: 'x'.repeat(301) })), /description/)
  assert.match(problem(pkg({ type: undefined })), /type must be "theme"/)
  assert.match(problem(pkg({ type: 'feature' })), /type must be "theme"/)
  assert.match(problem(pkg({ contract: 2 })), /contract/)
  assert.match(problem(pkg({ contract: undefined })), /contract/)
})

test('an installed plugin cannot declare what only a built-in may', () => {
  for (const key of ['secrets', 'projectSettings', 'legacyCapability', 'legacyBuiltIn']) {
    assert.match(problem(pkg({ [key]: key === 'secrets' ? ['linear'] : key === 'projectSettings' ? { a: 'string' } : key === 'legacyBuiltIn' ? true : 'mcp' })), new RegExp(`cannot declare ${key}`))
  }
})

test('the size limits', () => {
  assert.equal(problem(pkg({}, 'x'.repeat(MAX_PLUGIN_CLIENT_BYTES))), undefined)
  assert.match(problem(pkg({}, 'x'.repeat(MAX_PLUGIN_CLIENT_BYTES + 1))), /larger than 1 MB/)
  // Bytes, not characters: é is two.
  assert.match(problem(pkg({}, 'é'.repeat(MAX_PLUGIN_CLIENT_BYTES / 2 + 1))), /larger than 1 MB/)
  assert.match(problem(pkg({ description: 'x'.repeat(300), name: 'y'.repeat(64), extra: 'z'.repeat(20_000) })), /manifest is larger than 16 KB/)
})

test("the welcome's presence keeps an installed plugin's extra fields, and drops malformed ones", () => {
  const sha256 = 'a'.repeat(64)
  const [builtIn, installed, bad] = parsePluginPresence([
    { id: 'voice', version: '1.0.0', defaultEnabled: true },
    { id: 'solarized', version: '1.0.0', defaultEnabled: false, type: 'theme', name: 'Solarized', description: 'A calm theme.', contract: 1, sha256 },
    { id: 'odd', version: '1.0.0', defaultEnabled: false, type: 'other', name: 5, sha256: 'nope', contract: '1' }
  ])
  assert.deepEqual(builtIn, { id: 'voice', version: '1.0.0', defaultEnabled: true })
  assert.deepEqual(installed, { id: 'solarized', version: '1.0.0', defaultEnabled: false, type: 'theme', name: 'Solarized', description: 'A calm theme.', contract: 1, sha256 })
  assert.deepEqual(bad, { id: 'odd', version: '1.0.0', defaultEnabled: false })
})
