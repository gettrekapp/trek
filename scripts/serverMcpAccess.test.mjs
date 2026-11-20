// scripts/serverMcpAccess.test.mjs — per-project MCP tokens and their 0600 config files.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpAccessStore } from '../server/src/mcp/access.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'
import { builtinAgents } from './agentsHarness.mjs'

const agentFiles = () => builtinAgents().mcpFiles()

// Windows has no POSIX file modes (stat reports 0666 or 0444): the 0600/0700 checks are POSIX only.
const posix = process.platform !== 'win32'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-mcp-access-'))
  t.after(() => removeDir(dir))
  return { dir, mcpDir: join(dir, 'mcp') }
}

test('no access before the listener has a port', (t) => {
  const { mcpDir } = setup(t)
  assert.equal(new McpAccessStore(mcpDir, agentFiles).accessFor('p1'), undefined)
})

test('accessFor writes the Claude and Gemini files once per project, mode 0600', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir, agentFiles)
  store.setPort(4321)
  const a = store.accessFor('p1')
  assert.equal(a.url, 'http://127.0.0.1:4321/mcp')
  assert.match(a.token, /^[0-9a-f]{64}$/)
  assert.equal(a.files['.json'], join(mcpDir, 'p1.json'))
  assert.equal(a.files['.gemini.json'], join(mcpDir, 'p1.gemini.json'))
  assert.deepEqual(JSON.parse(readFileSync(a.files['.json'], 'utf8')), {
    mcpServers: { 'trek-dev': { type: 'http', url: a.url, headers: { Authorization: `Bearer ${a.token}` } } }
  })
  assert.deepEqual(JSON.parse(readFileSync(a.files['.gemini.json'], 'utf8')), {
    mcpServers: { 'trek-dev': { httpUrl: a.url, headers: { Authorization: `Bearer ${a.token}` }, trust: true } }
  })
  if (posix) assert.equal(statSync(a.files['.json']).mode & 0o777, 0o600)
  // Codex reads the token through a helper command, from a file of its own: never from env or argv.
  const codexFile = join(mcpDir, 'p1.codex.json')
  assert.equal(a.files['.codex.json'], codexFile, "Codex's helper is built by its plugin from this path")
  assert.deepEqual(JSON.parse(readFileSync(codexFile, 'utf8')), { Authorization: `Bearer ${a.token}` })
  if (posix) assert.equal(statSync(codexFile).mode & 0o777, 0o600)
  if (posix) assert.equal(statSync(mcpDir).mode & 0o777, 0o700)
  assert.deepEqual(store.accessFor('p1'), a, 'the same token and files on the next call')
  assert.notEqual(store.accessFor('p2').token, a.token)
})

test('projectFor matches the bearer header; revoke removes token and files', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir, agentFiles)
  store.setPort(1)
  const a = store.accessFor('p1')
  assert.equal(store.projectFor(`Bearer ${a.token}`), 'p1')
  assert.equal(store.projectFor(`Bearer ${'0'.repeat(64)}`), undefined)
  assert.equal(store.projectFor(undefined), undefined)
  assert.equal(store.projectFor('Basic x'), undefined)
  store.revoke('p1')
  assert.equal(store.projectFor(`Bearer ${a.token}`), undefined)
  assert.equal(existsSync(a.files['.json']), false)
  assert.equal(existsSync(a.files['.gemini.json']), false)
  assert.equal(existsSync(join(mcpDir, 'p1.codex.json')), false)
})

test('the constructor clears files from an earlier run', (t) => {
  const { mcpDir } = setup(t)
  mkdirSync(mcpDir, { recursive: true })
  writeFileSync(join(mcpDir, 'old.json'), '{}')
  new McpAccessStore(mcpDir, agentFiles)
  assert.equal(existsSync(join(mcpDir, 'old.json')), false)
})

test('an existing directory with a looser mode is tightened to 0700', { skip: posixOnly('file modes') }, (t) => {
  const { mcpDir } = setup(t)
  mkdirSync(mcpDir, { recursive: true })
  chmodSync(mcpDir, 0o755)
  new McpAccessStore(mcpDir, agentFiles)
  assert.equal(statSync(mcpDir).mode & 0o777, 0o700)
})

test('setPort drops cached access: new token, new port, files rewritten', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir, agentFiles)
  store.setPort(1111)
  const a = store.accessFor('p1')
  store.setPort(2222)
  assert.equal(store.projectFor(`Bearer ${a.token}`), undefined)
  const b = store.accessFor('p1')
  assert.equal(b.url, 'http://127.0.0.1:2222/mcp')
  assert.notEqual(b.token, a.token)
  assert.equal(JSON.parse(readFileSync(b.files['.json'], 'utf8')).mcpServers['trek-dev'].url, b.url)
  assert.equal(JSON.parse(readFileSync(b.files['.gemini.json'], 'utf8')).mcpServers['trek-dev'].httpUrl, b.url)
})

test('a symlinked mcp directory is refused and its target left alone', (t) => {
  const { dir, mcpDir } = setup(t)
  const target = join(dir, 'target')
  mkdirSync(target)
  chmodSync(target, 0o755)
  writeFileSync(join(target, 'keep.json'), '{}')
  symlinkSync(target, mcpDir)
  assert.throws(() => new McpAccessStore(mcpDir, agentFiles), /symbolic link/)
  assert.equal(existsSync(join(target, 'keep.json')), true)
  if (posix) assert.equal(statSync(target).mode & 0o777, 0o755)
})

test('an mcp path that is a file is refused', (t) => {
  const { mcpDir } = setup(t)
  writeFileSync(mcpDir, 'x')
  assert.throws(() => new McpAccessStore(mcpDir, agentFiles))
})

test('the startup wipe removes only .json and .tmp regular files', (t) => {
  const { mcpDir } = setup(t)
  mkdirSync(join(mcpDir, 'sub'), { recursive: true })
  writeFileSync(join(mcpDir, 'a.json'), '{}')
  writeFileSync(join(mcpDir, 'b.json.tmp'), '{}')
  writeFileSync(join(mcpDir, 'notes.txt'), 'hi')
  writeFileSync(join(mcpDir, 'sub', 'c.json'), '{}')
  new McpAccessStore(mcpDir, agentFiles)
  assert.equal(existsSync(join(mcpDir, 'a.json')), false)
  assert.equal(existsSync(join(mcpDir, 'b.json.tmp')), false)
  assert.equal(existsSync(join(mcpDir, 'notes.txt')), true)
  assert.equal(existsSync(join(mcpDir, 'sub', 'c.json')), true)
})

test('project ids are validated and -gemini ids cannot collide', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir, agentFiles)
  store.setPort(1)
  for (const bad of ['', '../x', 'a/b', '-a', 'a.b', 'a b']) {
    assert.throws(() => store.accessFor(bad), /project id/i, bad)
    assert.throws(() => store.revoke(bad), /project id/i, bad)
  }
  const a = store.accessFor('p1')
  const b = store.accessFor('p1-gemini')
  assert.notEqual(a.files['.gemini.json'], b.files['.json'])
  assert.notEqual(b.files['.gemini.json'], a.files['.json'])
})

test('a failed Gemini write removes the Claude file', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir, agentFiles)
  store.setPort(1)
  mkdirSync(join(mcpDir, 'p1.gemini.json'))
  assert.throws(() => store.accessFor('p1'))
  assert.equal(existsSync(join(mcpDir, 'p1.json')), false)
})

test('setPort removes the files of the access it drops', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir, agentFiles)
  store.setPort(1)
  const a = store.accessFor('p1')
  store.setPort(2)
  assert.equal(existsSync(a.files['.json']), false)
  assert.equal(existsSync(a.files['.gemini.json']), false)
})

test('accessFor rewrites deleted files with the same token (a second start swept them)', (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir, agentFiles)
  store.setPort(4321)
  const a = store.accessFor('p1')
  rmSync(a.files['.json'])
  rmSync(a.files['.gemini.json'])
  rmSync(join(mcpDir, 'p1.codex.json'))
  const b = store.accessFor('p1')
  assert.equal(b.token, a.token)
  assert.ok(existsSync(a.files['.json']) && existsSync(a.files['.gemini.json']))
  assert.equal(JSON.parse(readFileSync(a.files['.json'], 'utf8')).mcpServers['trek-dev'].headers.Authorization, `Bearer ${a.token}`)
  if (posix) assert.equal(statSync(a.files['.gemini.json']).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(join(mcpDir, 'p1.codex.json'), 'utf8')).Authorization, `Bearer ${a.token}`)
})

test("the files are the agents' (plugins A1): each suffix after the project id, with its content for the endpoint", (t) => {
  const { mcpDir } = setup(t)
  const store = new McpAccessStore(mcpDir, () => [{ suffix: '.probe.json', content: ({ url, token }) => JSON.stringify({ url, token }) }])
  store.setPort(7)
  const a = store.accessFor('p1')
  assert.deepEqual(a.files, { '.probe.json': join(mcpDir, 'p1.probe.json') })
  assert.deepEqual(JSON.parse(readFileSync(a.files['.probe.json'], 'utf8')), { url: 'http://127.0.0.1:7/mcp', token: a.token })
  assert.equal(existsSync(join(mcpDir, 'p1.json')), false, 'no file an agent did not ask for')
})
