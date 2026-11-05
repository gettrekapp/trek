// scripts/serverConfigStore.test.mjs — the config file as live state: repo add/remove, reload, watch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'

const loadConfig = (path) => JSON.parse(readFileSync(path, 'utf8'))

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-store-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function gitInit(path) {
  execFileSync('git', ['init', '-q', path])
  return path
}

/** dir/repos/a is registered, so dir/repos is an allowed root. dir/outside/c is not. */
function setup(t) {
  const dir = tempDir(t)
  const a = gitInit(join(dir, 'repos', 'a'))
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  t.after(() => store.close())
  let changes = 0
  store.on('change', () => changes++)
  return { dir, a, configPath, store, changes: () => changes }
}

function codeOf(fn) {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return 'no error'
}

test('addRepo under an allowed root saves, swaps and emits change', (t) => {
  const { dir, configPath, store, changes } = setup(t)
  const b = gitInit(join(dir, 'repos', 'b'))
  mkdirSync(join(b, 'src'))
  const { repo, added } = store.addRepo(join(b, 'src'), { requireAllowedRoot: true })
  assert.equal(added, true)
  assert.deepEqual(repo, { id: 'b', name: 'b', path: b })
  assert.deepEqual(store.config.repos.map((r) => r.id), ['a', 'b'])
  assert.deepEqual(loadConfig(configPath).repos.map((r) => r.id), ['a', 'b'])
  assert.equal(changes(), 1)
  assert.equal(store.guard.check(b), b)
})

test('addRepo outside the allowed roots is PATH_DENIED for RPC callers, allowed for the CLI', (t) => {
  const { dir, store } = setup(t)
  const c = gitInit(join(dir, 'outside', 'c'))
  assert.equal(codeOf(() => store.addRepo(c, { requireAllowedRoot: true })), 'PATH_DENIED')
  assert.equal(store.config.repos.length, 1)
  assert.equal(store.addRepo(c, { requireAllowedRoot: false }).added, true)
})

test('a path in an allowed root whose git root is outside it is PATH_DENIED', (t) => {
  const { dir, store } = setup(t)
  // dir itself becomes a repo; dir/repos/plain is allowed but resolves up to dir.
  gitInit(dir)
  mkdirSync(join(dir, 'repos', 'plain'))
  assert.equal(codeOf(() => store.addRepo(join(dir, 'repos', 'plain'), { requireAllowedRoot: true })), 'PATH_DENIED')
})

test('addRepo on a non-repo is NOT_A_REPO in both modes', (t) => {
  const { dir, store } = setup(t)
  mkdirSync(join(dir, 'repos', 'plain'))
  for (const requireAllowedRoot of [true, false]) {
    assert.equal(codeOf(() => store.addRepo(join(dir, 'repos', 'plain'), { requireAllowedRoot })), 'NOT_A_REPO')
    assert.equal(codeOf(() => store.addRepo(join(dir, 'repos', 'missing'), { requireAllowedRoot })), 'NOT_A_REPO')
  }
})

test('adding a registered path again changes nothing in both modes', (t) => {
  const { a, store, changes } = setup(t)
  for (const requireAllowedRoot of [true, false]) {
    const result = store.addRepo(a, { requireAllowedRoot })
    assert.equal(result.added, false)
    assert.equal(result.repo.id, 'a')
  }
  assert.equal(changes(), 0)
})

test('removeRepo by id or path; unknown is NOT_FOUND', (t) => {
  const { dir, a, store, changes } = setup(t)
  const b = gitInit(join(dir, 'repos', 'b'))
  store.addRepo(b, { requireAllowedRoot: false })
  assert.equal(store.removeRepo('b').id, 'b')
  assert.equal(store.removeRepo(a).id, 'a')
  assert.equal(store.config.repos.length, 0)
  assert.equal(codeOf(() => store.removeRepo('nope')), 'NOT_FOUND')
  assert.equal(changes(), 3)
})

test('removeRepo idOnly matches ids only, never paths', (t) => {
  const { a, store, changes } = setup(t)
  assert.equal(codeOf(() => store.removeRepo(a, { idOnly: true })), 'NOT_FOUND')
  assert.equal(codeOf(() => store.removeRepo(join(a, 'sub'), { idOnly: true })), 'NOT_FOUND')
  assert.equal(store.config.repos.length, 1)
  assert.equal(store.removeRepo('a', { idOnly: true }).id, 'a')
  assert.equal(store.config.repos.length, 0)
  assert.equal(changes(), 1)
})

test('removeRepo is IN_USE while projects use the repo', (t) => {
  const { store } = setup(t)
  store.setUsage((repo) => (repo.id === 'a' ? ['Project One', 'Project Two'] : []))
  assert.throws(() => store.removeRepo('a'), (err) => {
    assert.equal(err.code, 'IN_USE')
    assert.match(err.message, /Project One, Project Two/)
    return true
  })
  assert.equal(store.config.repos.length, 1)
})

test('update applies a mutation, saves and emits; a throwing mutation changes nothing', (t) => {
  const { configPath, store, changes } = setup(t)
  store.update((c) => {
    c.name = 'box'
  })
  assert.equal(store.config.name, 'box')
  assert.equal(loadConfig(configPath).name, 'box')
  assert.throws(() =>
    store.update((c) => {
      c.name = 'other'
      throw new Error('nope')
    })
  )
  assert.equal(store.config.name, 'box')
  assert.equal(loadConfig(configPath).name, 'box')
  assert.equal(changes(), 1)
})

test('reload picks up an external change and ignores an identical file', (t) => {
  const { configPath, store, changes } = setup(t)
  assert.equal(store.reload(), false)
  const next = loadConfig(configPath)
  next.worktreeRoots = ['/tmp']
  saveConfig(configPath, next)
  assert.equal(store.reload(), true)
  assert.deepEqual(store.config.worktreeRoots, ['/tmp'])
  assert.equal(changes(), 1)
})

test('reload keeps serverId, and a missing name, but allows a renamed server', (t) => {
  const { configPath, store } = setup(t)
  const warn = t.mock.method(console, 'warn', () => {})
  store.update((c) => {
    c.serverId = 'id-1'
    c.name = 'one'
  })
  const file = loadConfig(configPath)
  saveConfig(configPath, { ...file, serverId: 'id-2', name: undefined, worktreeRoots: ['/tmp'] })
  assert.equal(store.reload(), true)
  assert.equal(store.config.serverId, 'id-1')
  assert.equal(store.config.name, 'one')
  saveConfig(configPath, { ...file, serverId: undefined, name: 'two' })
  store.reload()
  assert.equal(store.config.serverId, 'id-1')
  assert.equal(store.config.name, 'two')
  assert.equal(warn.mock.callCount(), 1)
})

test('reload keeps the old config when the file is not valid JSON', (t) => {
  const { configPath, store, changes } = setup(t)
  writeFileSync(configPath, '{ not json')
  assert.equal(store.reload(), false)
  assert.equal(store.config.repos.length, 1)
  assert.equal(changes(), 0)
})

test('RPC add cannot climb: a root whose parent is not allowed is PATH_DENIED', (t) => {
  const { dir, store } = setup(t)
  gitInit(join(dir, 'repos'))
  gitInit(dir)
  assert.equal(codeOf(() => store.addRepo(join(dir, 'repos'), { requireAllowedRoot: true })), 'PATH_DENIED')
  const b = gitInit(join(dir, 'repos', 'b'))
  assert.equal(store.addRepo(b, { requireAllowedRoot: true }).added, true)
  assert.equal(store.config.repos.length, 2)
})

test('reload keeps the config when the file is missing', (t) => {
  t.mock.method(console, 'warn', () => {})
  const { configPath, store, changes } = setup(t)
  unlinkSync(configPath)
  assert.equal(store.reload(), false)
  assert.equal(store.config.repos.length, 1)
  assert.equal(changes(), 0)
})

test('reload keeps the config when the file has the wrong shape', (t) => {
  t.mock.method(console, 'warn', () => {})
  const { configPath, store, changes } = setup(t)
  for (const body of ['{"repos":[{"id":"q"}]}', '[]', '{"repos":[],"port":"x"}', 'null']) {
    writeFileSync(configPath, body)
    assert.equal(store.reload(), false, body)
    assert.deepEqual(store.config.repos.map((r) => r.id), ['a'])
  }
  assert.equal(changes(), 0)
})

test('the constructor throws on a wrongly shaped file', (t) => {
  const dir = tempDir(t)
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, '[]')
  assert.throws(() => new ConfigStore(configPath), /config/i)
})

test('a failing save leaves memory and disk unchanged', (t) => {
  const { configPath, store, changes } = setup(t)
  assert.throws(() =>
    store.update((c) => {
      c.worktreeRoots = [42]
      c.name = 'bad'
    })
  )
  assert.equal(store.config.name, undefined)
  assert.equal(loadConfig(configPath).name, undefined)
  assert.equal(changes(), 0)
})

test('watch on a missing config directory does not throw', (t) => {
  const dir = tempDir(t)
  const store = new ConfigStore(join(dir, 'nested', 'config.json'))
  t.after(() => store.close())
  assert.doesNotThrow(() => store.watch())
})

test('update starts from the file on disk, not a stale snapshot', (t) => {
  const { dir, configPath, store } = setup(t)
  const next = loadConfig(configPath)
  next.repos.push({ id: 'z', name: 'z', path: join(dir, 'repos', 'z') })
  saveConfig(configPath, next)
  store.update((c) => {
    c.name = 'n'
  })
  for (const config of [store.config, loadConfig(configPath)]) {
    assert.deepEqual(config.repos.map((r) => r.id), ['a', 'z'])
    assert.equal(config.name, 'n')
  }
})

test('watch reloads when another process rewrites the file', async (t) => {
  const { dir, configPath, store } = setup(t)
  store.watch()
  await new Promise((r) => setTimeout(r, 250))
  const timers = []
  let resolveChanged
  const changed = new Promise((resolve) => (resolveChanged = resolve))
  store.once('change', () => resolveChanged(true))
  const write = () => {
    const next = loadConfig(configPath)
    if (!next.repos.some((r) => r.id === 'z')) next.repos.push({ id: 'z', name: 'z', path: join(dir, 'repos', 'z') })
    else next.port = (next.port ?? 1000) + 1
    saveConfig(configPath, next)
  }
  write()
  const interval = setInterval(write, 300)
  timers.push(interval)
  const timeout = new Promise((_, reject) => timers.push(setTimeout(() => reject(new Error('no change event')), 5000)))
  try {
    await Promise.race([changed, timeout])
  } finally {
    timers.forEach((id) => (clearInterval(id), clearTimeout(id)))
  }
  assert.ok(store.config.repos.some((r) => r.id === 'z'))
})

test('the store\'s own update while watching emits exactly one change', async (t) => {
  const { store, changes } = setup(t)
  store.watch()
  await new Promise((r) => setTimeout(r, 250))
  store.update((c) => {
    c.name = 'solo'
  })
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(changes(), 1)
})

test('setUsage replaces the usage lookup', (t) => {
  const { store } = setup(t)
  store.setUsage(() => ['P'])
  assert.throws(() => store.removeRepo('a'), (err) => err.code === 'IN_USE')
})
