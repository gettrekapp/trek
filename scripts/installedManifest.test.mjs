// scripts/installedManifest.test.mjs — what may be installed as a plugin (theme plugins phase 1):
// checkPluginPackage's refusals, the manifest it stores, and the welcome's extra presence fields.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PLUGIN_CLIENT_BYTES, MAX_PLUGIN_MANIFEST_BYTES, PLUGIN_CONTRACT_VERSION, checkPluginPackage, parsePluginPresence } from '../src/shared/plugins/manifest.ts'

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

test('what is not an object, and fields of the wrong kind', () => {
  assert.match(problem([]), /must be an object/)
  assert.match(problem([{ manifest: MANIFEST, client: 'x' }]), /must be an object/)
  assert.match(problem('package'), /must be an object/)
  assert.match(problem({ manifest: [], client: 'x' }), /manifest must be an object/)
  assert.match(problem({ manifest: [MANIFEST], client: 'x' }), /manifest must be an object/)
  assert.match(problem(pkg({ id: 5 })), /not a plugin id/)
  assert.match(problem(pkg({ id: ['solarized'] })), /not a plugin id/)
  assert.match(problem(pkg({ id: undefined })), /not a plugin id/)
  assert.match(problem(pkg({ name: 5 })), /name must be/)
  assert.match(problem(pkg({ name: ['Solarized'] })), /name must be/)
  assert.match(problem(pkg({ description: {} })), /description must be/)
  assert.match(problem(pkg({ version: 1 })), /version/)
  assert.match(problem(pkg({}, 5)), /client must be a non-empty string/)
  assert.match(problem(pkg({}, '')), /client must be a non-empty string/)
})

test('constructor is not a usable id: it is a key of every plain object', () => {
  assert.match(problem(pkg({ id: 'constructor' })), /"constructor" is not a usable plugin id/)
  assert.equal(problem(pkg({ id: 'constructors' })), undefined)
})

test('the id a refusal echoes is cut at 40 characters', () => {
  const long = problem(pkg({ id: 'A'.repeat(5000) }))
  assert.ok(long.includes(`"${'A'.repeat(40)}…"`), long)
  assert.ok(!long.includes('A'.repeat(41)), long)
  assert.ok(long.length < 200, String(long.length))
  assert.ok(problem(pkg({ id: 'B'.repeat(40) })).includes(`"${'B'.repeat(40)}"`), 'forty are echoed whole')
  // An id that is not a string is not echoed at all.
  assert.ok(problem(pkg({ id: { huge: 'C'.repeat(5000) } })).length < 200)
})

test('name and description are stored trimmed, and have no control or invisible characters', () => {
  const checked = checkPluginPackage(pkg({ name: '  Solarized \n', description: '\tA calm theme.  ' }))
  assert.equal(checked.problem, undefined)
  assert.deepEqual([checked.package.manifest.name, checked.package.manifest.description], ['Solarized', 'A calm theme.'])
  for (const [what, bad] of [
    ['a newline', 'Solar\nized'],
    ['an escape', 'Solar\u001b[31mized'],
    ['a NUL', 'Solar\u0000ized'],
    ['a C1 control', 'Solar\u0085ized'],
    ['a right-to-left override', 'Solar\u202eized'],
    ['a zero-width space', 'Solar\u200bized'],
    ['a zero-width joiner', 'Solar\u200dized'],
    ['a byte-order mark', 'Solar\ufeffized']
  ]) {
    assert.match(problem(pkg({ name: bad })), /name must be 1 to 64 visible characters, with no control or invisible characters/, what)
    assert.match(problem(pkg({ description: bad })), /description must be 1 to 300 visible characters, with no control or invisible characters/, what)
  }
  for (const empty of ['   ', '\n\t', '\u200b', ' \u202e ']) {
    assert.match(problem(pkg({ name: empty })), /name must be/, JSON.stringify(empty))
    assert.match(problem(pkg({ description: empty })), /description must be/, JSON.stringify(empty))
  }
  assert.equal(problem(pkg({ name: 'Señor Ünïcode 日本語 🎨', description: 'Émojis 🎨 and accents are text.' })), undefined)
})

test('name and description at their limits, measured after trimming', () => {
  const atLimit = checkPluginPackage(pkg({ name: 'n'.repeat(64), description: 'd'.repeat(300) }))
  assert.equal(atLimit.problem, undefined)
  assert.deepEqual([atLimit.package.manifest.name.length, atLimit.package.manifest.description.length], [64, 300])
  assert.equal(problem(pkg({ name: `  ${'n'.repeat(64)}  `, description: ` ${'d'.repeat(300)} ` })), undefined, 'the spaces around are not counted')
  assert.match(problem(pkg({ name: 'n'.repeat(65) })), /name must be/)
  assert.match(problem(pkg({ description: 'd'.repeat(301) })), /description must be/)
})

test('version is at most 64 characters', () => {
  const at = `1.0.0-${'a'.repeat(58)}`
  assert.equal(at.length, 64)
  assert.equal(checkPluginPackage(pkg({ version: at })).package.manifest.version, at)
  assert.match(problem(pkg({ version: `${at}a` })), /version must be .*at most 64 characters/)
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

test('the manifest limit at its boundary, in bytes', () => {
  // Measured as checkPluginPackage does: the UTF-8 bytes of the manifest as compact JSON.
  const bytes = (manifest) => new TextEncoder().encode(JSON.stringify(manifest)).length
  const room = MAX_PLUGIN_MANIFEST_BYTES - bytes(pkg({ extra: '' }).manifest)
  const exact = pkg({ extra: 'x'.repeat(room) })
  assert.equal(bytes(exact.manifest), 16_384)
  assert.equal(problem(exact), undefined)
  assert.match(problem(pkg({ extra: 'x'.repeat(room + 1) })), /manifest is larger than 16 KB/)
  // é is two bytes: half as many characters fill it.
  const wide = pkg({ extra: 'é'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2) })
  assert.equal(bytes(wide.manifest), 16_384)
  assert.ok(JSON.stringify(wide.manifest).length < 16_384 - 7000)
  assert.equal(problem(wide), undefined)
  assert.match(problem(pkg({ extra: 'é'.repeat(Math.floor(room / 2) + 1) })), /manifest is larger than 16 KB/)
})

test('a client longer than the limit is refused by its length, before its bytes are counted', (t) => {
  const encode = t.mock.method(TextEncoder.prototype, 'encode')
  const client = 'x'.repeat(MAX_PLUGIN_CLIENT_BYTES + 1)
  assert.match(problem(pkg({}, client)), /larger than 1 MB/)
  assert.ok(!encode.mock.calls.some((call) => call.arguments[0] === client), 'the oversized client was never encoded')
  assert.equal(problem(pkg({}, 'x'.repeat(MAX_PLUGIN_CLIENT_BYTES))), undefined)
  assert.ok(encode.mock.calls.some((call) => call.arguments[0].length === MAX_PLUGIN_CLIENT_BYTES), 'one within the length is')
})

test('checkPluginPackage never throws: a manifest that cannot be measured is a problem', () => {
  let deep = []
  for (let i = 0; i < 200_000; i++) deep = [deep]
  const cyclic = { ...MANIFEST }
  cyclic.self = cyclic
  for (const [what, manifest] of [['nested 200,000 deep', { ...MANIFEST, extra: deep }], ['cyclic', cyclic], ['a BigInt', { ...MANIFEST, extra: 1n }], ['a toJSON that throws', { ...MANIFEST, toJSON() { throw new Error('no') } }]]) {
    let checked
    assert.doesNotThrow(() => { checked = checkPluginPackage({ manifest, client: 'export default {}' }) }, what)
    assert.match(checked.problem, /manifest cannot be measured/, what)
  }
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
