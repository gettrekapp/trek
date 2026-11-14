// scripts/serverIntegrations.test.mjs — the server's secrets file, skills.list and the test
// endpoints (phase 5b). (linear.* and voice.* are the Linear and voice plugins': scripts/linearPlugin.test.mjs,
// scripts/voicePlugin.test.mjs.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretFile, secretsPathFor } from '../server/src/secrets.ts'
import { createIntegrations, testEndpoint } from '../server/src/integrations/integrations.ts'
import { readBodyCapped } from '../src/host/httpBody.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { posixOnly } from './testPlatform.mjs'
// The server's own realpath: on Windows the native one, which expands 8.3 names (RUNNER~1) as git does.
import { realPath } from '../src/host/pathContainment.ts'

// Windows has no POSIX file modes: the 0600 checks are POSIX only.
const posix = process.platform !== 'win32'

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-integrations-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const refused = (res, code) => {
  assert.equal(res.ok, false, JSON.stringify(res))
  assert.equal(res.error.code, code, res.error.message)
}

test('the secrets file: beside the config, 0600, set, set-if-absent and clear', (t) => {
  const dir = tempDir(t)
  const path = secretsPathFor(join(dir, 'config.json'))
  assert.equal(path, join(dir, 'secrets.json'))
  const file = createSecretFile(path)
  assert.equal(file.get('linear'), null)
  file.set('linear', 'k1')
  if (posix) assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(file.setIfAbsent('linear', 'k2'), false)
  assert.equal(file.get('linear'), 'k1')
  assert.equal(file.setIfAbsent('elevenlabs', 'e1'), true)
  file.set('linear', null)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { elevenlabs: 'e1' })
  // `__proto__` is just a name, never the object's prototype.
  file.set('__proto__', 'p')
  assert.equal(file.get('__proto__'), 'p')
  assert.equal(file.get('constructor'), null)
})

test('the secrets file: one that cannot be parsed throws, and is never replaced', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'secrets.json')
  writeFileSync(path, '{"linear": "k1", torn')
  const file = createSecretFile(path)
  assert.throws(() => file.get('linear'), /not valid JSON/)
  assert.throws(() => file.set('elevenlabs', 'e1'), /not valid JSON/)
  assert.equal(readFileSync(path, 'utf8'), '{"linear": "k1", torn')
})

test('TopicHub.emit reaches the subscribers that take events and counts the ones it was sent to', () => {
  const hub = new TopicHub()
  hub.publish('project:p', {})
  const got = []
  hub.subscribe('project:p', { send() {}, event: (e, p) => (got.push([e, p]), true) })
  hub.subscribe('project:p', { send() {}, event: () => false })
  hub.subscribe('project:p', { send() {} })
  hub.subscribe('project:p', { send() {}, event: () => { throw new Error('boom') } })
  assert.equal(hub.emit('project:p', 'voice.summary', { x: 1 }), 1)
  assert.deepEqual(got, [['voice.summary', { x: 1 }]])
  assert.equal(hub.emit('project:nope', 'voice.summary', {}), 0)
})

test("skills.list reads the worktree's .claude and the server user's ~/.claude; the project shadows the user", async (t) => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const dir = realPath(tempDir(t))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a])
  execFileSync('git', ['-C', a, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init'])
  const write = (path, text) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  write(join(a, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: "Review the branch"\n---\nbody')
  write(join(a, '.claude', 'commands', 'ship.md'), 'no frontmatter')
  const home = join(dir, 'home')
  write(join(home, '.claude', 'skills', 'review', 'SKILL.md'), '---\ndescription: the user one\n---\n')
  write(join(home, '.claude', 'skills', 'notes', 'SKILL.md'), `---\ndescription: ${'x'.repeat(130)}\n---\n`)
  mkdirSync(join(home, '.claude', 'skills', 'empty'), { recursive: true })
  write(join(home, '.claude', 'commands', 'todo.md'), '---\ndescription: List todos\n---\n')
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
  t.after(() => {
    poller.stop()
    store.close()
  })
  const integrations = createIntegrations({ home })
  const ctx = { store, hub, subscriber: { send: () => {} }, projects, poller, integrations }
  const call = (method, params) => dispatchV2(method, params, ctx)
  const projectId = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result.projectId
  await poller.refresh(a)
  const main = projects.require(projectId).repositories[0].worktrees[0]
  const listed = await call('skills.list', { projectId, worktreeId: main.id })
  assert.deepEqual(listed.result, [
    { name: 'review', description: 'Review the branch', source: 'project', kind: 'skill' },
    { name: 'ship', description: undefined, source: 'project', kind: 'command' },
    { name: 'notes', description: `${'x'.repeat(120)}…`, source: 'user', kind: 'skill' },
    { name: 'todo', description: 'List todos', source: 'user', kind: 'command' }
  ])
  // A row the guard does not cover; an unknown worktree.
  const outside = realPath(tempDir(t))
  projects.apply(projectId, (d) => {
    d.repositories[0].worktrees.push({ id: 'out', name: 'out', path: outside, branch: 'x', isMain: false, loaded: false, sessions: [] })
  })
  refused(await call('skills.list', { projectId, worktreeId: 'out' }), 'PATH_DENIED')
  refused(await call('skills.list', { projectId, worktreeId: 'nope' }), 'NOT_FOUND')
})

/** The secrets file a directory: every read of it fails (EISDIR), whoever runs the test. */
test('readBodyCapped: content-length over the cap, a stream over the cap, and one under it', async () => {
  const stream = (bytes) => new ReadableStream({ start(c) { for (let i = 0; i < bytes; i += 10) c.enqueue(new Uint8Array(10)); c.close() } })
  await assert.rejects(readBodyCapped(new Response('x'.repeat(20), { headers: { 'content-length': '20' } }), 10, 'The reply'), /The reply is larger than 10 bytes/)
  await assert.rejects(readBodyCapped(new Response(stream(30)), 25, 'The reply'), /larger than 25 bytes/)
  assert.equal((await readBodyCapped(new Response(stream(30)), 30, 'The reply')).length, 30)
  assert.equal((await readBodyCapped(new Response(null), 30, 'The reply')).length, 0)
})

/** A worktree for skills.list, as the first skills test makes it. */
async function skillsSetup(t) {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const dir = realPath(tempDir(t))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a])
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const integrations = createIntegrations({ home })
  return { dir, a, home, list: () => integrations.skills.list(a) }
}

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

test('skills.list skips FIFOs and links to devices, and reads only a file\'s head', { skip: posixOnly('FIFOs and device files'), timeout: 10_000 }, async (t) => {
  const s = await skillsSetup(t)
  for (const root of [join(s.a, '.claude'), join(s.home, '.claude')]) {
    mkdirSync(join(root, 'skills', 'fifo'), { recursive: true })
    execFileSync('mkfifo', [join(root, 'skills', 'fifo', 'SKILL.md')])
    mkdirSync(join(root, 'skills', 'zero'), { recursive: true })
    symlinkSync('/dev/zero', join(root, 'skills', 'zero', 'SKILL.md'))
    mkdirSync(join(root, 'commands'), { recursive: true })
    execFileSync('mkfifo', [join(root, 'commands', 'pipe.md')])
  }
  // Frontmatter that ends past the first 16 KiB is not read; a big file's head still is.
  write(join(s.a, '.claude', 'skills', 'long', 'SKILL.md'), `---\n${'# pad\n'.repeat(3000)}description: too far\n---\n`)
  write(join(s.a, '.claude', 'skills', 'big', 'SKILL.md'), `---\ndescription: Big one\n---\n${'x'.repeat(2 * 1024 * 1024)}`)
  write(join(s.home, '.claude', 'commands', 'huge.md'), `---\ndescription: Huge\n---\n${'x'.repeat(2 * 1024 * 1024)}`)
  assert.deepEqual(await s.list(), [
    { name: 'big', description: 'Big one', source: 'project', kind: 'skill' },
    { name: 'long', description: undefined, source: 'project', kind: 'skill' },
    { name: 'huge', description: 'Huge', source: 'user', kind: 'command' }
  ])
})

test("skills.list lists nothing from a worktree's .claude (or its skills dir) that leads outside the worktree", async (t) => {
  const s = await skillsSetup(t)
  const outside = join(s.dir, 'outside')
  write(join(outside, 'skills', 'stolen', 'SKILL.md'), '---\ndescription: from outside\n---\n')
  write(join(outside, 'commands', 'leak.md'), '---\ndescription: from outside\n---\n')
  symlinkSync(outside, join(s.a, '.claude'))
  assert.deepEqual(await s.list(), [])
  // A real .claude whose skills dir links out: its commands are still listed.
  rmSync(join(s.a, '.claude'))
  write(join(s.a, '.claude', 'commands', 'ship.md'), '---\ndescription: Ship it\n---\n')
  symlinkSync(join(outside, 'skills'), join(s.a, '.claude', 'skills'))
  // A SKILL.md that links out of the worktree is not read either.
  write(join(s.home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\ndescription: the user one\n---\n')
  assert.deepEqual(await s.list(), [
    { name: 'ship', description: 'Ship it', source: 'project', kind: 'command' },
    { name: 'mine', description: 'the user one', source: 'user', kind: 'skill' }
  ])
  rmSync(join(s.a, '.claude', 'skills'))
  mkdirSync(join(s.a, '.claude', 'skills', 'linked'), { recursive: true })
  symlinkSync(join(outside, 'skills', 'stolen', 'SKILL.md'), join(s.a, '.claude', 'skills', 'linked', 'SKILL.md'))
  assert.deepEqual((await s.list()).map((x) => x.name), ['ship', 'mine'])
})

test('the test endpoints (TREK_SERVER_LINEAR_URL, TREK_SERVER_ELEVENLABS_URL) are taken only on loopback', () => {
  const warned = []
  const warn = (m) => warned.push(m)
  assert.equal(testEndpoint('X', undefined, warn), undefined)
  assert.equal(testEndpoint('X', '', warn), undefined)
  assert.equal(testEndpoint('X', 'http://127.0.0.1:4000/graphql', warn), 'http://127.0.0.1:4000/graphql')
  assert.equal(testEndpoint('X', 'https://localhost/v1', warn), 'https://localhost/v1')
  assert.equal(testEndpoint('X', 'http://[::1]:9/v1', warn), 'http://[::1]:9/v1')
  // The URL as parsed (the one that was checked), not the string as given.
  assert.equal(testEndpoint('X', 'HTTP://LOCALHOST:9/v1', warn), 'http://localhost:9/v1')
  assert.equal(testEndpoint('X', 'http://127.0.0.1:9/a/../v1', warn), 'http://127.0.0.1:9/v1')
  assert.deepEqual(warned, [])
  for (const bad of ['https://evil.example/graphql', 'http://127.0.0.1.evil.example/', 'file:///etc/passwd', 'http://10.0.0.1/', 'not a url', 'http://localhost@evil.example/']) {
    assert.equal(testEndpoint('X', bad, warn), undefined, bad)
  }
  assert.equal(warned.length, 6)
  assert.match(warned[0], /X/)
})
