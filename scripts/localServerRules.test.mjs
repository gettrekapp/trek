// scripts/localServerRules.test.mjs — the Local server supervisor's pure decisions: what a probe
// found, version skew, the child's env, a failed start, what a restart does after `stop --local`,
// and when "Reset local server" may delete the lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEV_LOCAL_PROFILE,
  LOCAL_ENTRY_ID,
  LOG_ROTATE_BYTES,
  afterStop,
  childEnv,
  compareVersions,
  localPaths,
  localProfileArgs,
  localProfileName,
  localUrl,
  logTail,
  parseBuildJson,
  probeVerdict,
  resetDecision,
  skewOf,
  spawnFailure
} from '../src/main/localServerRules.ts'

const info = { port: 51234, pid: 4242, token: 'a'.repeat(43), version: '0.2.0', build: '0123456789ab' }

test('the paths: the profile from src/shared/localServer.ts, and the log beside local.json', () => {
  assert.deepEqual(localPaths('/home/u'), {
    dir: '/home/u/.config/trek-server/local',
    config: '/home/u/.config/trek-server/local/config.json',
    info: '/home/u/.config/trek-server/local/local.json',
    lock: '/home/u/.config/trek-server/local/local.lock',
    log: '/home/u/.config/trek-server/local/server.log'
  })
  assert.equal(localUrl(51234), 'ws://127.0.0.1:51234')
  assert.equal(LOCAL_ENTRY_ID, 'local')
})

test('the profile: the default one when packaged, local-dev for a dev build, with its own files', () => {
  assert.equal(localProfileName(true), undefined)
  assert.equal(localProfileName(false), 'dev')
  assert.equal(DEV_LOCAL_PROFILE, 'dev')
  assert.deepEqual(localProfileArgs(localProfileName(true)), [])
  assert.deepEqual(localProfileArgs(localProfileName(false)), ['--local-profile', 'dev'])
  assert.deepEqual(localPaths('/home/u', undefined), localPaths('/home/u'))
  assert.deepEqual(localPaths('/home/u', 'dev'), {
    dir: '/home/u/.config/trek-server/local-dev',
    config: '/home/u/.config/trek-server/local-dev/config.json',
    info: '/home/u/.config/trek-server/local-dev/local.json',
    lock: '/home/u/.config/trek-server/local-dev/local.lock',
    log: '/home/u/.config/trek-server/local-dev/server.log'
  })
  assert.throws(() => localPaths('/home/u', '../x'), /Invalid local profile name/)
})

test('parseBuildJson takes the bundle stamp, nothing else', () => {
  assert.deepEqual(parseBuildJson({ version: '0.2.0', build: '0123456789ab', extra: 1 }), { version: '0.2.0', build: '0123456789ab' })
  assert.deepEqual(parseBuildJson({ version: '0.2.0', build: 'dev' }), { version: '0.2.0', build: 'dev' })
  for (const raw of [null, [], 'x', {}, { version: '', build: 'dev' }, { version: '1', build: 'XYZ' }, { version: 1, build: 'dev' }]) {
    assert.equal(parseBuildJson(raw), undefined, JSON.stringify(raw))
  }
})

test('probeVerdict: only a live pid whose hello is welcomed as this profile\'s local server is used', () => {
  const welcome = { capabilities: ['mcp', 'local'], serverId: 'srv-1' }
  assert.deepEqual(probeVerdict({ info, alive: true, welcome, expectedServerId: 'srv-1' }), { use: true })
  assert.deepEqual(probeVerdict({ info, alive: true, welcome, expectedServerId: undefined }), { use: true }, 'no serverId in the config yet')
  assert.deepEqual(probeVerdict({ info: undefined, alive: false, welcome: undefined }), { use: false, why: 'no local.json' })
  assert.deepEqual(probeVerdict({ info, alive: false, welcome: undefined }), { use: false, why: 'pid 4242 is gone' })
  assert.deepEqual(probeVerdict({ info, alive: true, welcome: undefined }), { use: false, why: 'pid 4242 does not answer on port 51234' })
  assert.deepEqual(probeVerdict({ info, alive: true, welcome: { capabilities: ['mcp'], serverId: 'srv-1' } }), {
    use: false,
    why: 'the server on port 51234 is not a local server'
  })
  assert.deepEqual(probeVerdict({ info, alive: true, welcome, expectedServerId: 'srv-2' }), {
    use: false,
    why: 'the server on port 51234 is another profile (srv-1)'
  })
})

test('compareVersions: numeric, part by part; anything unparsable compares equal', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1)
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), 0)
})

test('skewOf: none for the same version and build; otherwise older, newer or another build', () => {
  const bundled = { version: '0.2.0', build: '0123456789ab' }
  assert.equal(skewOf(bundled, info), null)
  assert.deepEqual(skewOf(bundled, { ...info, version: '0.1.0', build: 'ffffffffffff' }), { relation: 'older', running: '0.1.0 (ffffffffffff)', bundled: '0.2.0 (0123456789ab)' })
  assert.deepEqual(skewOf(bundled, { ...info, version: '0.3.0' }), { relation: 'newer', running: '0.3.0 (0123456789ab)', bundled: '0.2.0 (0123456789ab)' })
  assert.deepEqual(skewOf(bundled, { ...info, build: 'dev' }), { relation: 'other-build', running: '0.2.0 (dev)', bundled: '0.2.0 (0123456789ab)' })
  assert.equal(skewOf(undefined, info), null, 'no build.json (a dev run without out/server): nothing to compare')
})

test('childEnv: Electron\'s Node, the fixed PATH, and nothing from the app or a Trek session', () => {
  const env = childEnv({
    PATH: '/usr/bin:/opt/homebrew/bin',
    HOME: '/home/u',
    SHELL: '/bin/zsh',
    ELECTRON_RENDERER_URL: 'http://localhost:5173',
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_ENABLE_LOGGING: '1',
    NODE_OPTIONS: '--inspect',
    TREK_MCP_TOKEN: 'secret',
    TREK_TERMINAL_ID: 't1',
    TREK_NO_WINDOW_RESTORE: '1',
    GIT_DIR: '/x/.git'
  })
  assert.deepEqual(env, { PATH: '/usr/bin:/opt/homebrew/bin', HOME: '/home/u', SHELL: '/bin/zsh', ELECTRON_RUN_AS_NODE: '1' })
})

test('spawnFailure: exit 3 is a lock held elsewhere, "Cannot take the lock" is the filesystem, the rest an exit', () => {
  assert.deepEqual(spawnFailure(3, 'x'), { kind: 'lock-held' })
  assert.deepEqual(spawnFailure(1, 'line\nCannot take the lock /p/local.lock: EISDIR: illegal operation on a directory\n'), {
    kind: 'lock-error',
    message: 'Cannot take the lock /p/local.lock: EISDIR: illegal operation on a directory'
  })
  assert.deepEqual(spawnFailure(1, 'boom'), { kind: 'exited', message: 'The local server exited with code 1' })
  assert.deepEqual(spawnFailure('SIGKILL', ''), { kind: 'exited', message: 'The local server exited with SIGKILL' })
})

test('afterStop: spawn once stopped; SIGKILL only the pid that both the lock and local.json still name', () => {
  assert.equal(afterStop({ code: 0, target: 4242, lockPid: undefined, infoPid: undefined, alive: false }), 'spawn')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 4242, infoPid: 4242, alive: true }), 'sigkill', 'a timeout: still running')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: undefined, infoPid: undefined, alive: false }), 'spawn', 'gone by the time we look')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 4242, infoPid: 4242, alive: false }), 'spawn', 'dead: the next start takes its files over')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 999, infoPid: 4242, alive: true }), 'refuse', 'the lock is someone else\'s')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: undefined, infoPid: 4242, alive: true }), 'refuse', 'lockless')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 4242, infoPid: 5555, alive: true }), 'refuse', 'local.json moved on')
  assert.equal(afterStop({ code: 2, target: 4242, lockPid: 4242, infoPid: 4242, alive: true }), 'refuse', 'a usage error is a bug: never kill on it')
})

test('resetDecision: the lock goes only when nothing that could be our server holds it', () => {
  // No lock: just start.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: undefined, lockAlive: false, info: undefined, welcomed: false, portOpen: false }), 'start')
  // A server answers with local.json's token: it is live, connect to it.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info, welcomed: true, portOpen: true }), 'connect')
  // The lock's pid is dead: the next start would take it over anyway.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: false, info, welcomed: false, portOpen: false }), 'reset')
  // Alive, and local.json names another pid (or none): a reused pid.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info: undefined, welcomed: false, portOpen: false }), 'reset')
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info: { ...info, pid: 77 }, welcomed: false, portOpen: true }), 'reset')
  // Alive, local.json names it, and its port is closed: a SIGKILLed server's pid, reused.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info, welcomed: false, portOpen: false }), 'reset')
  // Alive, named by local.json, its port open, but no welcome: maybe our server, hung. Never reset.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info, welcomed: false, portOpen: true }), 'refuse')
  // A live pid's fresh lock: a start still on its way to local.json. Never reset.
  assert.equal(resetDecision({ lockAgeMs: 2_000, lockPid: 4242, lockAlive: true, info: undefined, welcomed: false, portOpen: false }), 'refuse')
  assert.equal(resetDecision({ lockAgeMs: 2_000, lockPid: 4242, lockAlive: false, info: undefined, welcomed: false, portOpen: false }), 'reset', 'dead: age does not matter')
})

test('logTail: the last lines, trimmed; rotation past 1 MB', () => {
  assert.equal(logTail('a\nb\nc\n\n', 2), 'b\nc')
  assert.equal(logTail('', 5), '')
  assert.equal(LOG_ROTATE_BYTES, 1024 * 1024)
})
