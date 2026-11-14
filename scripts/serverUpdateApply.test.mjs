// scripts/serverUpdateApply.test.mjs — one update, start to finish, against a fake signed feed:
// found, downloaded, checked, self-checked and swapped in; and every way it stops with the
// running install untouched. Then what `trek-server update` says about each way it can end.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCK_FILE, applyUpdate, findUpdate, runStagedSelfcheck } from '../server/src/update/apply.ts'
import { awaitVersion, confirmQuestion, describeOutcome } from '../server/src/update/command.ts'
import { PENDING_FILE, readState, writeState } from '../server/src/update/state.ts'
import { POSIX_LAUNCHER } from './serverLaunchers.mjs'
import { posixOnly, removeDir } from './testPlatform.mjs'

const tar = { skip: posixOnly('an update unpacks a release tarball with tar, and Windows has no self-update') }
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const KEY = publicKey.export({ type: 'spki', format: 'pem' })
const FEED = 'http://127.0.0.1:1/releases'
const NOW = new Date('2026-11-14T10:00:00.000Z')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function folder(root, name, version, target = 'linux-x64', launcher = { text: '#!/bin/sh\n', mode: 0o755 }) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'trek-server'), launcher.text, { mode: launcher.mode })
  writeFileSync(join(dir, 'trek-server.cjs'), `// ${version}\n`)
  writeFileSync(join(dir, 'build.json'), JSON.stringify({ version, build: 'b', package: 'tarball', target }))
  return dir
}

/**
 * An install of `current`, and a feed whose latest release is `latest`. `built`: the version the
 * tarball's own build.json names; `loose`: the tarball also holds a second top-level folder;
 * `tamper` changes what the feed serves after it is signed; `launcher`: the released bin/trek-server.
 */
function world({ current = '1.0.0', latest = '2.0.0', built = latest, loose = false, tamper, launcher } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'trek-apply-'))
  const parent = join(root, 'opt')
  const configDir = join(root, 'config')
  mkdirSync(configDir, { recursive: true })
  const dir = folder(parent, 'trek-server', current)
  const name = `trek-server-${latest}-linux-x64`
  folder(join(root, 'release'), name, built, 'linux-x64', launcher)
  if (loose) mkdirSync(join(root, 'release', 'extra'))
  const tarball = join(root, `${name}.tar.gz`)
  execFileSync('tar', ['-czf', tarball, '-C', join(root, 'release'), name, ...(loose ? ['extra'] : [])], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const bytes = readFileSync(tarball)
  const sums = `${sha(bytes)}  ${name}.tar.gz\n`
  const files = {
    [`${FEED}/latest/download/SHA256SUMS`]: Buffer.from(sums),
    [`${FEED}/latest/download/SHA256SUMS.sig`]: Buffer.from(sign(null, Buffer.from(sums), privateKey).toString('base64')),
    [`${FEED}/download/v${latest}/${name}.tar.gz`]: bytes
  }
  tamper?.(files, name)
  const asked = []
  const selfchecks = []
  const deps = {
    install: { dir, parent, version: current, build: 'b', target: 'linux-x64' },
    configDir,
    feed: FEED,
    keys: [KEY],
    fetch: async (url) => {
      asked.push(String(url))
      const body = files[String(url)]
      return body === undefined ? new Response('no', { status: 404 }) : new Response(body)
    },
    now: () => NOW,
    selfcheck: (staged) => {
      selfchecks.push(staged)
      return { ok: true, output: 'ok' }
    }
  }
  const versionAt = (path) => JSON.parse(readFileSync(join(path, 'build.json'), 'utf8')).version
  return { root, parent, dir, configDir, deps, files, asked, selfchecks, sha256: sha(bytes), versionAt, done: () => removeDir(root) }
}
/** What is beside the install that an update must not leave: its download, its staging folder, its lock. */
const leftovers = (w) => readdirSync(w.parent).filter((entry) => entry !== 'trek-server' && entry !== 'trek-server.previous')
/** The install is as it was before the update: its version, no marker, nothing kept beside it. */
function untouched(w, version = '1.0.0') {
  assert.equal(w.versionAt(w.dir), version)
  assert.deepEqual(readdirSync(w.dir).sort(), ['bin', 'build.json', 'trek-server.cjs'], 'nothing is written into the install')
  assert.equal(existsSync(`${w.dir}.previous`), false)
  assert.deepEqual(leftovers(w), [], 'the download, the staging folder and the lock are gone')
}

test('findUpdate: a newer release is found and remembered; the same or an older one is not an update', tar, async () => {
  const newer = world()
  const same = world({ latest: '1.0.0' })
  const older = world({ current: '3.0.0' })
  try {
    assert.deepEqual(await findUpdate(newer.deps), { version: '2.0.0', file: 'trek-server-2.0.0-linux-x64.tar.gz', sha256: newer.sha256 })
    assert.deepEqual(readState(newer.configDir), { lastCheckAt: NOW.toISOString(), latest: '2.0.0' })
    assert.equal(await findUpdate(same.deps), null)
    assert.equal(await findUpdate(older.deps), null, 'a lower version is never installed')
    assert.deepEqual(readState(older.configDir), { lastCheckAt: NOW.toISOString() }, 'no latest when there is nothing newer')
    assert.ok([...newer.asked, ...same.asked, ...older.asked].every((url) => !url.endsWith('.tar.gz')), 'looking downloads nothing')
  } finally {
    for (const w of [newer, same, older]) w.done()
  }
})

test('findUpdate: a feed that cannot be read or verified throws, and what the last check found stays', tar, async () => {
  const w = world()
  try {
    writeState(w.configDir, { lastCheckAt: '2026-11-01T00:00:00.000Z', latest: '1.5.0' })
    const before = readState(w.configDir)
    const signature = w.files[`${FEED}/latest/download/SHA256SUMS.sig`]
    w.files[`${FEED}/latest/download/SHA256SUMS.sig`] = Buffer.from('A'.repeat(88))
    await assert.rejects(findUpdate(w.deps), /signature/)
    assert.deepEqual(readState(w.configDir), before, 'an unverified feed records nothing')
    delete w.files[`${FEED}/latest/download/SHA256SUMS`]
    await assert.rejects(findUpdate(w.deps), /HTTP 404/)
    await assert.rejects(findUpdate({ ...w.deps, fetch: async () => { throw new Error('getaddrinfo ENOTFOUND') } }), /ENOTFOUND/)
    await assert.rejects(findUpdate({ ...w.deps, keys: [] }), /no update key/)
    assert.deepEqual(readState(w.configDir), before)

    // Once it verifies again, the check is recorded.
    w.files[`${FEED}/latest/download/SHA256SUMS.sig`] = signature
    w.files[`${FEED}/latest/download/SHA256SUMS`] = Buffer.from(`${w.sha256}  trek-server-2.0.0-linux-x64.tar.gz\n`)
    await findUpdate(w.deps)
    assert.deepEqual(readState(w.configDir), { lastCheckAt: NOW.toISOString(), latest: '2.0.0' })
  } finally {
    w.done()
  }
})

test('applyUpdate installs the new version at the install path, marked pending, with the old one kept', tar, async () => {
  const w = world()
  const steps = []
  try {
    const result = await applyUpdate({ ...w.deps, onStep: (step) => steps.push(step) })
    assert.deepEqual(result, { kind: 'installed', from: '1.0.0', to: '2.0.0' })
    assert.equal(w.versionAt(w.dir), '2.0.0')
    assert.equal(w.versionAt(`${w.dir}.previous`), '1.0.0')
    assert.deepEqual(JSON.parse(readFileSync(join(w.dir, PENDING_FILE), 'utf8')), { from: '1.0.0', to: '2.0.0', at: NOW.toISOString() })
    assert.deepEqual(readdirSync(`${w.dir}.previous`).sort(), ['bin', 'build.json', 'trek-server.cjs'], 'the old version is kept exactly as it was: no marker in it')
    assert.deepEqual(steps, ['checking', 'downloading', 'unpacking', 'selfcheck', 'installing'])
    assert.equal(w.selfchecks.length, 1)
    assert.ok(w.selfchecks[0].startsWith(w.parent), 'the staged version is beside the install')
    assert.deepEqual(leftovers(w), [], 'the download, the staging folder and the lock are gone')
    assert.deepEqual(readState(w.configDir), { lastCheckAt: NOW.toISOString(), latest: '2.0.0' }, 'the new server records the result when it starts, not the installer')
  } finally {
    w.done()
  }
})

test('the marker is written into the staged folder, and the swap is the last thing that happens', tar, async () => {
  const w = world()
  try {
    let seen
    await applyUpdate({
      ...w.deps,
      selfcheck: (staged) => {
        // Up to here nothing has touched the install, and the staged version is not marked yet.
        seen = { install: readdirSync(w.dir).sort(), version: w.versionAt(w.dir), marked: existsSync(join(staged, PENDING_FILE)), previous: existsSync(`${w.dir}.previous`) }
        return { ok: true, output: '' }
      }
    })
    assert.deepEqual(seen, { install: ['bin', 'build.json', 'trek-server.cjs'], version: '1.0.0', marked: false, previous: false })
  } finally {
    w.done()
  }
})

test('nothing newer is up to date, and nothing is downloaded', tar, async () => {
  const w = world({ latest: '1.0.0' })
  try {
    assert.deepEqual(await applyUpdate(w.deps), { kind: 'up-to-date', current: '1.0.0' })
    assert.ok(w.asked.every((url) => !url.endsWith('.tar.gz')))
    untouched(w)
    assert.equal(readState(w.configDir).lastResult, undefined)
  } finally {
    w.done()
  }
})

for (const [what, options, message, to] of [
  ['a SHA256SUMS that is not signed by a built-in key', { tamper: (files) => { files[`${FEED}/latest/download/SHA256SUMS.sig`] = Buffer.from('A'.repeat(88)) } }, /signature/, '1.0.0'],
  ['a feed that cannot be read', { tamper: (files) => { delete files[`${FEED}/latest/download/SHA256SUMS`] } }, /HTTP 404/, '1.0.0'],
  ['a tarball that is not the one the checksums name', { tamper: (files, name) => { files[`${FEED}/download/v2.0.0/${name}.tar.gz`] = Buffer.from('other bytes') } }, /sha256/, '2.0.0'],
  ['a tarball that cannot be downloaded', { tamper: (files, name) => { delete files[`${FEED}/download/v2.0.0/${name}.tar.gz`] } }, /HTTP 404/, '2.0.0'],
  ['a tarball that holds more than one folder', { loose: true }, /must hold one folder/, '2.0.0'],
  ['a tarball whose build.json names another version', { built: '2.0.1' }, /is trek-server 2\.0\.1, not 2\.0\.0/, '2.0.0']
]) {
  test(`${what} fails the update and leaves the install untouched`, tar, async () => {
    const w = world(options)
    try {
      const result = await applyUpdate(w.deps)
      assert.equal(result.kind, 'failed')
      assert.match(result.error, message)
      untouched(w)
      assert.equal(w.selfchecks.length, 0, 'never run')
      const { lastResult } = readState(w.configDir)
      assert.deepEqual({ ...lastResult, error: undefined }, { ok: false, from: '1.0.0', to, at: NOW.toISOString(), error: undefined })
      assert.match(lastResult.error, message)
    } finally {
      w.done()
    }
  })
}

test('a tarball that is not a tarball at all fails the update', tar, async () => {
  const garbage = Buffer.from('not gzip, not tar')
  const w = world({
    tamper: (files, name) => {
      const sums = `${sha(garbage)}  ${name}.tar.gz\n`
      files[`${FEED}/latest/download/SHA256SUMS`] = Buffer.from(sums)
      files[`${FEED}/latest/download/SHA256SUMS.sig`] = Buffer.from(sign(null, Buffer.from(sums), privateKey).toString('base64'))
      files[`${FEED}/download/v2.0.0/${name}.tar.gz`] = garbage
    }
  })
  try {
    const result = await applyUpdate(w.deps)
    assert.equal(result.kind, 'failed')
    untouched(w)
    assert.equal(readState(w.configDir).lastResult.to, '2.0.0')
  } finally {
    w.done()
  }
})

test('a new version that fails its selfcheck is never swapped in', tar, async () => {
  const w = world()
  try {
    const result = await applyUpdate({ ...w.deps, selfcheck: () => ({ ok: false, output: 'FAIL: node-pty loads\n  library load disallowed' }) })
    assert.equal(result.kind, 'failed')
    assert.match(result.error, /2\.0\.0 does not run on this machine/)
    assert.match(result.error, /library load disallowed/)
    untouched(w)
    assert.deepEqual([readState(w.configDir).lastResult.from, readState(w.configDir).lastResult.to], ['1.0.0', '2.0.0'])

    // A selfcheck that throws is a failure like any other.
    const thrown = await applyUpdate({ ...w.deps, selfcheck: () => { throw new Error('spawn failed') } })
    assert.deepEqual(thrown, { kind: 'failed', error: 'spawn failed' })
    untouched(w)
  } finally {
    w.done()
  }
})

test('a swap that cannot happen fails the update with the install where it was', { skip: posixOnly('file modes') || (process.getuid?.() === 0 && 'root can remove anything') }, async () => {
  const w = world()
  const locked = join(`${w.dir}.previous`, 'locked')
  try {
    // An older kept version that cannot be removed: the swap stops before it renames anything.
    mkdirSync(locked, { recursive: true })
    writeFileSync(join(locked, 'file'), '')
    chmodSync(locked, 0o500)
    const result = await applyUpdate(w.deps)
    assert.equal(result.kind, 'failed')
    assert.equal(w.versionAt(w.dir), '1.0.0')
    assert.deepEqual(readdirSync(w.dir).sort(), ['bin', 'build.json', 'trek-server.cjs'])
    assert.deepEqual(leftovers(w), [])
    assert.deepEqual([readState(w.configDir).lastResult.ok, readState(w.configDir).lastResult.to], [false, '2.0.0'])
  } finally {
    chmodSync(locked, 0o700)
    w.done()
  }
})

test('a failure that cannot be recorded is still the failure that is returned', tar, async () => {
  const w = world({ tamper: (files) => { delete files[`${FEED}/latest/download/SHA256SUMS`] } })
  try {
    // The config folder's path is a file: update-state.json cannot be written.
    const result = await applyUpdate({ ...w.deps, configDir: join(w.dir, 'build.json') })
    assert.equal(result.kind, 'failed')
    assert.match(result.error, /HTTP 404/)
    untouched(w)
  } finally {
    w.done()
  }
})

test('one update at a time: a live lock holder is refused and told what the lock is; a lock left behind is taken over', tar, async () => {
  const w = world()
  const lock = join(w.parent, LOCK_FILE)
  const holder = join(lock, 'holder')
  try {
    assert.equal(LOCK_FILE, '.trek-update.lock')
    // This process is alive: so is a second update started in it while the first runs.
    mkdirSync(lock)
    writeFileSync(holder, `${process.pid}\n`)
    const busy = await applyUpdate(w.deps)
    assert.equal(busy.kind, 'failed')
    assert.match(busy.error, /another update is running/)
    assert.ok(busy.error.includes(`${lock} is its lock`), busy.error)
    assert.match(busy.error, /If no update is running, remove it\./)
    assert.equal(w.versionAt(w.dir), '1.0.0')
    assert.equal(readFileSync(holder, 'utf8'), `${process.pid}\n`, 'the holder keeps its lock')
    assert.deepEqual(readdirSync(w.parent).sort(), [LOCK_FILE, 'trek-server'], 'and the attempt left nothing beside it')
    assert.deepEqual(w.asked, [], 'and nothing was asked of the feed')
    assert.equal(readState(w.configDir).lastResult, undefined, 'the update that is running records its own result')

    // After a reboot: the process id is a live process's, and the lock is older than any update takes.
    const longAgo = new Date(Date.now() - 31 * 60 * 1000)
    utimesSync(holder, longAgo, longAgo)
    assert.equal((await applyUpdate(w.deps)).kind, 'installed')
    assert.deepEqual(leftovers(w), [])
  } finally {
    w.done()
  }
  // A holder that cannot be alive, and one that names no process.
  for (const left of ['2147483646', '', 'not a pid']) {
    const again = world()
    try {
      mkdirSync(join(again.parent, LOCK_FILE))
      writeFileSync(join(again.parent, LOCK_FILE, 'holder'), left)
      assert.equal((await applyUpdate(again.deps)).kind, 'installed', `a lock holding ${JSON.stringify(left)}`)
      assert.deepEqual(leftovers(again), [])
    } finally {
      again.done()
    }
  }
})

test('two updates started together: one installs, the other is refused', tar, async () => {
  const w = world()
  try {
    const results = await Promise.all([applyUpdate(w.deps), applyUpdate(w.deps)])
    assert.deepEqual(results.map((r) => r.kind).sort(), ['failed', 'installed'])
    assert.match(results.find((r) => r.kind === 'failed').error, /another update is running/)
    assert.equal(w.versionAt(w.dir), '2.0.0')
    assert.deepEqual(leftovers(w), [])
  } finally {
    w.done()
  }
})

test('an older <install>.previous from the update before is replaced', tar, async () => {
  const w = world()
  try {
    folder(w.parent, 'trek-server.previous', '0.9.0')
    await applyUpdate(w.deps)
    assert.equal(w.versionAt(`${w.dir}.previous`), '1.0.0')
  } finally {
    w.done()
  }
})

for (const [what, launcher, message] of [
  ['is not executable', { text: POSIX_LAUNCHER, mode: 0o644 }, /selfcheck could not be run/],
  ['exits with an error', { text: '#!/bin/sh\necho "launcher: broken" >&2\nexit 3\n', mode: 0o755 }, /launcher: broken/],
  ['is not a shell script that parses', { text: '#!/bin/sh\nif then fi (\n', mode: 0o755 }, /does not run on this machine/]
]) {
  test(`a release whose launcher ${what} fails the update before the swap, and leaves the install untouched`, tar, async () => {
    const w = world({ launcher })
    try {
      // The real selfcheck: it runs the staged version through its own launcher.
      const result = await applyUpdate({ ...w.deps, selfcheck: undefined })
      assert.equal(result.kind, 'failed')
      assert.match(result.error, /2\.0\.0 does not run on this machine/)
      assert.match(result.error, message)
      untouched(w)
      assert.equal(readState(w.configDir).lastResult.ok, false)
    } finally {
      w.done()
    }
  })
}

test('the staged selfcheck runs the staged version through its own launcher, with the Node given: its exit code decides, its output is kept', { skip: posixOnly('the launcher is a POSIX sh script') }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'trek-apply-check-'))
  const staged = (name, source, launcher = { text: POSIX_LAUNCHER, mode: 0o755 }) => {
    const dir = join(root, name)
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'trek-server.cjs'), source)
    if (launcher) writeFileSync(join(dir, 'bin', 'trek-server'), launcher.text, { mode: launcher.mode })
    return dir
  }
  const env = { ...process.env, TREK_NODE: process.execPath }
  const check = (dir, timeoutMs) => runStagedSelfcheck(dir, timeoutMs, env)
  try {
    assert.deepEqual(
      check(staged('fine', "console.log('ok: ' + process.argv.slice(2).join(' ') + ' ' + (process.execPath === " + JSON.stringify(process.execPath) + "))")),
      { ok: true, output: 'ok: selfcheck true' }
    )
    assert.equal(existsSync(join(root, 'fine', 'update-pending.tried')), false, 'a selfcheck is not a start: nothing is marked')
    const failed = check(staged('fails', "console.log('ok: node-pty loads'); console.error('FAIL: a terminal runs\\n  posix_spawnp failed'); process.exit(1)"))
    assert.equal(failed.ok, false)
    assert.match(failed.output, /ok: node-pty loads/)
    assert.match(failed.output, /FAIL: a terminal runs\n {2}posix_spawnp failed/, 'stderr is kept too')

    const started = Date.now()
    const hung = check(staged('hangs', "console.log('ok: started'); setInterval(() => {}, 1000)"), 500)
    assert.equal(hung.ok, false)
    assert.match(hung.output, /ok: started/)
    assert.match(hung.output, /did not finish within 0\.5 s/)
    assert.ok(Date.now() - started < 20_000)

    const crashed = check(staged('crashes', "process.kill(process.pid, 'SIGKILL')"))
    assert.equal(crashed.ok, false)
    assert.match(crashed.output, /ended by SIGKILL/)

    const missing = check(join(root, 'nowhere'))
    assert.equal(missing.ok, false)
    assert.match(missing.output, /selfcheck could not be run/)

    // What the bundle alone would pass, the launcher that will start it must pass too.
    const fine = "console.log('ok')"
    const notExecutable = check(staged('mode', fine, { text: POSIX_LAUNCHER, mode: 0o644 }))
    assert.equal(notExecutable.ok, false)
    assert.match(notExecutable.output, /selfcheck could not be run/)
    assert.equal(check(staged('syntax', fine, { text: '#!/bin/sh\nif then fi (\n', mode: 0o755 })).ok, false)
    assert.equal(check(staged('exits', fine, { text: '#!/bin/sh\nexit 3\n', mode: 0o755 })).ok, false)

    // The Node is the one named: the one the server will be started again with.
    const noNode = runStagedSelfcheck(staged('no-node', fine), undefined, { ...process.env, TREK_NODE: join(root, 'no-such-node') })
    assert.equal(noNode.ok, false)
    assert.match(noNode.output, /Node\.js 22 or later is needed, and .*no-such-node.* was not found/)
    const other = join(root, 'other-node')
    writeFileSync(other, '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 22; exit 0; fi\necho "other node ran $2"\n', { mode: 0o755 })
    assert.deepEqual(runStagedSelfcheck(staged('other', fine), undefined, { ...process.env, TREK_NODE: other }), { ok: true, output: 'other node ran selfcheck' })
  } finally {
    removeDir(root)
  }
})

test('the question says what a restart costs: the running server\'s terminals', () => {
  const server = (sessions, canRelaunch = true) => ({ pid: 7, sessions, canRelaunch })
  assert.equal(confirmQuestion('1.0.0', '2.0.0', null), 'Update trek-server 1.0.0 to 2.0.0?')
  assert.equal(confirmQuestion('1.0.0', '2.0.0', server(0)), 'Update trek-server 1.0.0 to 2.0.0? The running server (pid 7) restarts into it; it has no terminals open.')
  assert.equal(
    confirmQuestion('1.0.0', '2.0.0', server(1)),
    'Update trek-server 1.0.0 to 2.0.0? The running server (pid 7) restarts into it: its 1 terminal closes, and agent sessions resume when their worktrees are opened again.'
  )
  assert.equal(
    confirmQuestion('1.0.0', '2.0.0', server(12)),
    'Update trek-server 1.0.0 to 2.0.0? The running server (pid 7) restarts into it: its 12 terminals close, and agent sessions resume when their worktrees are opened again.'
  )
  // A server that says it cannot restart itself is not said to.
  for (const sessions of [0, 3]) {
    assert.equal(
      confirmQuestion('1.0.0', '2.0.0', server(sessions, false)),
      'Update trek-server 1.0.0 to 2.0.0? The running server (pid 7) cannot restart itself into it (its Node is older than 22.15): it keeps running 1.0.0 until you restart it.'
    )
  }
})

test('awaitVersion asks the running server until it says it is the new version, and gives up after its time', async () => {
  const NEW = { pid: 7, version: '2.0.0', installDir: '/opt/trek-server', sessions: 0, canRelaunch: true }
  const OLD = { ...NEW, version: '1.0.0' }
  /** A clock that only sleep() moves, and a server whose answers are `answers` in turn (the last one repeats). */
  const fake = (answers) => {
    let t = 0
    let asked = 0
    const sleeps = []
    return {
      deps: {
        request: async () => answers[Math.min(asked++, answers.length - 1)],
        now: () => t,
        sleep: async (ms) => { sleeps.push(ms); t += ms },
        timeoutMs: 1000,
        everyMs: 250
      },
      asked: () => asked,
      sleeps
    }
  }
  // Still the old version, then gone (shutting down, no socket), then garbage, then the new one.
  const comes = fake([OLD, null, null, { ok: false }, NEW])
  assert.deepEqual(await awaitVersion('2.0.0', comes.deps), NEW)
  assert.equal(comes.asked(), 5)
  assert.deepEqual(comes.sleeps, [250, 250, 250, 250])

  const at_once = fake([NEW])
  assert.deepEqual(await awaitVersion('2.0.0', at_once.deps), NEW)
  assert.deepEqual(at_once.sleeps, [], 'no wait when it is already there')

  const never = fake([null])
  assert.equal(await awaitVersion('2.0.0', never.deps), null)
  assert.deepEqual(never.sleeps, [250, 250, 250, 250], 'bounded by the clock')
  assert.equal(never.asked(), 5, 'asked once more when the time is up')

  // A server that stays the old version (the restart did not happen) is not the new one.
  assert.equal(await awaitVersion('2.0.0', fake([OLD]).deps), null)
})

test('what `trek-server update` says, and its exit code, for each way it ends', () => {
  const said = (outcome) => describeOutcome(outcome)
  assert.deepEqual(said({ kind: 'cannot-update', reason: 'the local server is part of the Trek app and is updated with it' }), {
    exitCode: 1,
    lines: ['trek-server cannot update itself here: the local server is part of the Trek app and is updated with it']
  })
  assert.deepEqual(said({ kind: 'feed-error', error: 'could not read SHA256SUMS (HTTP 404)' }), { exitCode: 1, lines: ['Could not check for an update: could not read SHA256SUMS (HTTP 404)'] })
  assert.deepEqual(said({ kind: 'latest', current: '2.0.0' }), { exitCode: 0, lines: ['trek-server 2.0.0 is the latest version'] })
  assert.deepEqual(said({ kind: 'available', current: '1.0.0', latest: '2.0.0' }), { exitCode: 0, lines: ['trek-server 1.0.0; 2.0.0 is available (run `trek-server update`)'] })
  assert.deepEqual(said({ kind: 'other-install', configPath: '/c/config.json', pid: 7, installDir: '/opt/other' }), {
    exitCode: 1,
    lines: ['The server running with /c/config.json (pid 7) is another install, /opt/other: run its own `trek-server update`.']
  })
  assert.deepEqual(said({ kind: 'needs-yes', latest: '2.0.0' }), { exitCode: 1, lines: ['trek-server 2.0.0 is available. Run `trek-server update --yes` to install it without being asked.'] })
  assert.deepEqual(said({ kind: 'declined' }), { exitCode: 0, lines: ['Not updated.'] })
  assert.deepEqual(said({ kind: 'failed', current: '1.0.0', error: 'the sha256 is wrong' }), { exitCode: 1, lines: ['The update failed, and trek-server 1.0.0 is as it was:', 'the sha256 is wrong'] })
  assert.deepEqual(said({ kind: 'installed', to: '2.0.0', previous: '/opt/trek-server.previous' }), {
    exitCode: 0,
    lines: [
      'Updated to trek-server 2.0.0. The version before it is kept in /opt/trek-server.previous.',
      'No running server answered for this config. A trek-server that is already running from this install still runs the old version: restart it to use 2.0.0.'
    ]
  })
  assert.deepEqual(said({ kind: 'restarted', to: '2.0.0', pid: 7 }), { exitCode: 0, lines: ['Installed trek-server 2.0.0; the running server (pid 7) is now running 2.0.0.'] })
  assert.deepEqual(said({ kind: 'restart-unconfirmed', to: '2.0.0', pid: 7, seconds: 15 }), {
    exitCode: 1,
    lines: ['Installed trek-server 2.0.0. The running server (pid 7) agreed to restart into it, but has not come back as 2.0.0 within 15 s: look at its log, and start it again if it is not running.']
  })
  assert.deepEqual(said({ kind: 'restart-needed', to: '2.0.0', pid: 7, why: 'Node 22.14.0 cannot replace a running process (22.15 or later can)' }), {
    exitCode: 0,
    lines: ['Installed trek-server 2.0.0. Restart the running server (pid 7) to finish: Node 22.14.0 cannot replace a running process (22.15 or later can).']
  })
  assert.deepEqual(said({ kind: 'restart-needed', to: '2.0.0', pid: 7, why: 'the running server did not answer' }).lines, [
    'Installed trek-server 2.0.0. Restart the running server (pid 7) to finish: the running server did not answer.'
  ])
})
