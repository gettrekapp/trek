// scripts/serverTokens.test.mjs — named tokens: add/rotate, revoke, list, match, v1 migration.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeTokenHashes,
  addToken,
  formatTokenList,
  hashToken,
  listTokens,
  matchToken,
  migrateLegacyToken,
  revokeToken
} from '../server/src/tokens.ts'

test('hashToken is sha256 hex', () => {
  assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('addToken returns a token that matches its entry', () => {
  const config = { repos: [] }
  const token = addToken(config, 'laptop', new Date('2026-11-05T10:00:00Z'))
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(config.tokens, [
    { name: 'laptop', hash: hashToken(token), createdAt: '2026-11-05T10:00:00.000Z' }
  ])
  assert.equal(matchToken(config, token).name, 'laptop')
  assert.equal(matchToken(config, 'wrong'), undefined)
})

test('adding an existing name rotates it', () => {
  const config = { repos: [] }
  const first = addToken(config, 'phone')
  const second = addToken(config, 'phone')
  assert.equal(config.tokens.length, 1)
  assert.equal(matchToken(config, first), undefined)
  assert.equal(matchToken(config, second).name, 'phone')
})

test('tokens are independent', () => {
  const config = { repos: [] }
  const a = addToken(config, 'a')
  const b = addToken(config, 'b')
  assert.equal(matchToken(config, a).name, 'a')
  assert.equal(matchToken(config, b).name, 'b')
  assert.deepEqual(activeTokenHashes(config), new Set([hashToken(a), hashToken(b)]))
})

test('revokeToken removes only that token', () => {
  const config = { repos: [] }
  const a = addToken(config, 'a')
  const b = addToken(config, 'b')
  assert.equal(revokeToken(config, 'a'), true)
  assert.equal(revokeToken(config, 'a'), false)
  assert.equal(matchToken(config, a), undefined)
  assert.equal(matchToken(config, b).name, 'b')
})

test('invalid names are refused', () => {
  for (const name of ['', ' x', 'a b', '-x', 'x'.repeat(65)]) {
    assert.throws(() => addToken({ repos: [] }, name), /Invalid token name/)
  }
})

test("v1's tokenHash matches as \"default\" before and after migration", () => {
  const config = { tokenHash: hashToken('old'), repos: [] }
  assert.equal(matchToken(config, 'old').name, 'default')
  assert.deepEqual(listTokens(config).map((t) => t.name), ['default'])
  assert.equal(migrateLegacyToken(config), true)
  assert.equal(config.tokenHash, undefined)
  assert.deepEqual(config.tokens, [{ name: 'default', hash: hashToken('old'), createdAt: '' }])
  assert.equal(matchToken(config, 'old').name, 'default')
  assert.equal(migrateLegacyToken(config), false)
})

test('rotating "default" replaces a migrated v1 token', () => {
  const config = { tokenHash: hashToken('old'), repos: [] }
  const fresh = addToken(config, 'default')
  assert.equal(config.tokenHash, undefined)
  assert.equal(matchToken(config, 'old'), undefined)
  assert.equal(matchToken(config, fresh).name, 'default')
})

test('formatTokenList aligns names and shows unknown dates', () => {
  assert.equal(
    formatTokenList([
      { name: 'default', hash: 'x', createdAt: '' },
      { name: 'ph', hash: 'y', createdAt: '2026-11-05T10:00:00.000Z' }
    ]),
    ['NAME     CREATED', 'default  unknown', 'ph       2026-11-05T10:00:00.000Z'].join('\n')
  )
  assert.match(formatTokenList([]), /No tokens/)
})

test('malformed token entries are skipped, not thrown on', () => {
  const good = { name: 'ok', hash: hashToken('good'), createdAt: '' }
  const config = { repos: [], tokens: [{ name: 'bad' }, { name: 'x', hash: 42 }, { hash: hashToken('n') }, good] }
  assert.deepEqual(listTokens(config), [good])
  assert.equal(matchToken(config, 'good').name, 'ok')
  assert.equal(matchToken(config, 'other'), undefined)
})

test('a tokens "default" entry wins over a stale v1 tokenHash', () => {
  const config = {
    repos: [],
    tokenHash: hashToken('old'),
    tokens: [{ name: 'default', hash: hashToken('new'), createdAt: '' }]
  }
  assert.equal(matchToken(config, 'old'), undefined)
  assert.equal(matchToken(config, 'new').name, 'default')
  migrateLegacyToken(config)
  assert.deepEqual(config.tokens.filter((t) => t.name === 'default').map((t) => t.hash), [hashToken('new')])
  assert.equal(config.tokens.length, 1)
})
