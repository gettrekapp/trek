// scripts/serverMcpAccess.test.mjs — per-project MCP tokens and their 0600 config files.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpAccessStore } from '../server/src/mcp/access.ts'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-mcp-access-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, mcpDir: join(dir, 'mcp') }
}

test('no access before the listener has a port', (t) => {
  const { mcpDir } = setup(t)
  assert.equal(new McpAccessStore(mcpDir).accessFor('p1'), undefined)
})

test('accessFor writes the Claude and Gemini files once per project, mode 0600', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir)
  store.setPort(4321)
  const a = store.accessFor('p1')
  assert.equal(a.url, 'http://127.0.0.1:4321/mcp')
  assert.match(a.token, /^[0-9a-f]{64}$/)
  assert.equal(a.configPath, join(mcpDir, 'p1.json'))
  assert.equal(a.geminiSettingsPath, join(mcpDir, 'p1.gemini.json'))
  assert.deepEqual(JSON.parse(readFileSync(a.configPath, 'utf8')), {
    mcpServers: { 'trek-dev': { type: 'http', url: a.url, headers: { Authorization: `Bearer ${a.token}` } } }
  })
  assert.deepEqual(JSON.parse(readFileSync(a.geminiSettingsPath, 'utf8')), {
    mcpServers: { 'trek-dev': { httpUrl: a.url, headers: { Authorization: `Bearer ${a.token}` }, trust: true } }
  })
  assert.equal(statSync(a.configPath).mode & 0o777, 0o600)
  assert.equal(statSync(mcpDir).mode & 0o777, 0o700)
  assert.deepEqual(store.accessFor('p1'), a, 'the same token and files on the next call')
  assert.notEqual(store.accessFor('p2').token, a.token)
})

test('projectFor matches the bearer header; revoke removes token and files', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir)
  store.setPort(1)
  const a = store.accessFor('p1')
  assert.equal(store.projectFor(`Bearer ${a.token}`), 'p1')
  assert.equal(store.projectFor(`Bearer ${'0'.repeat(64)}`), undefined)
  assert.equal(store.projectFor(undefined), undefined)
  assert.equal(store.projectFor('Basic x'), undefined)
  store.revoke('p1')
  assert.equal(store.projectFor(`Bearer ${a.token}`), undefined)
  assert.equal(existsSync(a.configPath), false)
  assert.equal(existsSync(a.geminiSettingsPath), false)
})

test('the constructor clears files from an earlier run', (t) => {
  const { mcpDir } = setup(t)
  mkdirSync(mcpDir, { recursive: true })
  writeFileSync(join(mcpDir, 'old.json'), '{}')
  new McpAccessStore(mcpDir)
  assert.equal(existsSync(join(mcpDir, 'old.json')), false)
})

test('an existing directory with a looser mode is tightened to 0700', (t) => {
  const { mcpDir } = setup(t)
  mkdirSync(mcpDir, { recursive: true })
  chmodSync(mcpDir, 0o755)
  new McpAccessStore(mcpDir)
  assert.equal(statSync(mcpDir).mode & 0o777, 0o700)
})

test('setPort drops cached access: new token, new port, files rewritten', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir)
  store.setPort(1111)
  const a = store.accessFor('p1')
  store.setPort(2222)
  assert.equal(store.projectFor(`Bearer ${a.token}`), undefined)
  const b = store.accessFor('p1')
  assert.equal(b.url, 'http://127.0.0.1:2222/mcp')
  assert.notEqual(b.token, a.token)
  assert.equal(JSON.parse(readFileSync(b.configPath, 'utf8')).mcpServers['trek-dev'].url, b.url)
  assert.equal(JSON.parse(readFileSync(b.geminiSettingsPath, 'utf8')).mcpServers['trek-dev'].httpUrl, b.url)
})

test('a symlinked mcp directory is refused and its target left alone', (t) => {
  const { dir, mcpDir } = setup(t)
  const target = join(dir, 'target')
  mkdirSync(target)
  chmodSync(target, 0o755)
  writeFileSync(join(target, 'keep.json'), '{}')
  symlinkSync(target, mcpDir)
  assert.throws(() => new McpAccessStore(mcpDir), /symbolic link/)
  assert.equal(existsSync(join(target, 'keep.json')), true)
  assert.equal(statSync(target).mode & 0o777, 0o755)
})

test('an mcp path that is a file is refused', (t) => {
  const { mcpDir } = setup(t)
  writeFileSync(mcpDir, 'x')
  assert.throws(() => new McpAccessStore(mcpDir))
})

test('the startup wipe removes only .json and .tmp regular files', (t) => {
  const { mcpDir } = setup(t)
  mkdirSync(join(mcpDir, 'sub'), { recursive: true })
  writeFileSync(join(mcpDir, 'a.json'), '{}')
  writeFileSync(join(mcpDir, 'b.json.tmp'), '{}')
  writeFileSync(join(mcpDir, 'notes.txt'), 'hi')
  writeFileSync(join(mcpDir, 'sub', 'c.json'), '{}')
  new McpAccessStore(mcpDir)
  assert.equal(existsSync(join(mcpDir, 'a.json')), false)
  assert.equal(existsSync(join(mcpDir, 'b.json.tmp')), false)
  assert.equal(existsSync(join(mcpDir, 'notes.txt')), true)
  assert.equal(existsSync(join(mcpDir, 'sub', 'c.json')), true)
})

test('project ids are validated and -gemini ids cannot collide', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir)
  store.setPort(1)
  for (const bad of ['', '../x', 'a/b', '-a', 'a.b', 'a b']) {
    assert.throws(() => store.accessFor(bad), /project id/i, bad)
    assert.throws(() => store.revoke(bad), /project id/i, bad)
  }
  const a = store.accessFor('p1')
  const b = store.accessFor('p1-gemini')
  assert.notEqual(a.geminiSettingsPath, b.configPath)
  assert.notEqual(b.geminiSettingsPath, a.configPath)
})

test('a failed Gemini write removes the Claude file', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir)
  store.setPort(1)
  mkdirSync(join(mcpDir, 'p1.gemini.json'))
  assert.throws(() => store.accessFor('p1'))
  assert.equal(existsSync(join(mcpDir, 'p1.json')), false)
})

test('setPort removes the files of the access it drops', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir)
  store.setPort(1)
  const a = store.accessFor('p1')
  store.setPort(2)
  assert.equal(existsSync(a.configPath), false)
  assert.equal(existsSync(a.geminiSettingsPath), false)
})
