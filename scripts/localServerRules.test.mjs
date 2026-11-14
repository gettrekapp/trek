// scripts/localServerRules.test.mjs — the Local server supervisor's pure decisions: what a probe
// found, version skew, the child's env, a failed start, what a restart does after `stop --local`,
// and when "Reset local server" may delete the lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  DEV_LOCAL_PROFILE,
  LOCAL_ENTRY_ID,
  LOCAL_PROFILE_ENV,
  LOG_ROTATE_BYTES,
  LOST_RACE_MIN_WAIT_MS,
  READY_TIMEOUT_MS,
  afterStop,
  childEnv,
  compareVersions,
  isLocalServerCommand,
  keepAfterFailure,
  localPaths,
  localProfileArgs,
  localProfileName,
  localServerDisabled,
  localUrl,
  logTail,
  lostRaceDeadline,
  parseBuildJson,
  probeVerdict,
  resetDecision,
  sameFile,
  skewOf,
  spawnFailure
} from '../src/main/localServerRules.ts'

/** A profile's files on Linux under /home/u, as this machine's join() spells them. */
const linuxProfile = (segment) => {
  const dir = join('/home/u', '.config', 'trek-server', segment)
  return { dir, config: join(dir, 'config.json'), info: join(dir, 'local.json'), lock: join(dir, 'local.lock'), log: join(dir, 'server.log') }
}

const info = { port: 51234, pid: 4242, token: 'a'.repeat(43), version: '0.2.0', build: '0123456789ab' }

test('the paths: the profile from src/shared/localServer.ts, and the log beside local.json', () => {
  // Linux's layout, joined by this machine's node:path (backslashes on Windows).
  assert.deepEqual(localPaths('/home/u', undefined, 'linux', {}), linuxProfile('local'))
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
  assert.deepEqual(localPaths('/home/u', 'dev', 'linux', {}), linuxProfile('local-dev'))
  assert.throws(() => localPaths('/home/u', '../x'), /Invalid local profile name/)
  // An invalid name never reaches the command line: localProfileName never returns one, and localProfileArgs throws.
  for (const bad of ['../x', '-', '--local', 'Dev', '']) assert.throws(() => localProfileArgs(bad), /Invalid local profile name/, bad)
})

test('TREK_LOCAL_PROFILE: a dev build takes a valid name, an invalid one is dev; a packaged build ignores it', () => {
  assert.equal(LOCAL_PROFILE_ENV, 'TREK_LOCAL_PROFILE')
  assert.equal(localProfileName(false, { TREK_LOCAL_PROFILE: 'dev-wt2' }), 'dev-wt2')
  assert.deepEqual(localProfileArgs(localProfileName(false, { TREK_LOCAL_PROFILE: 'dev-wt2' })), ['--local-profile', 'dev-wt2'])
  assert.equal(localPaths('/home/u', localProfileName(false, { TREK_LOCAL_PROFILE: 'dev-wt2' }), 'linux', {}).dir, join('/home/u', '.config', 'trek-server', 'local-dev-wt2'))
  for (const bad of ['', '../x', '-wt', 'Dev', 'a b', 'x'.repeat(33)]) assert.equal(localProfileName(false, { TREK_LOCAL_PROFILE: bad }), 'dev', bad)
  assert.equal(localProfileName(false, {}), 'dev')
  assert.equal(localProfileName(true, { TREK_LOCAL_PROFILE: 'dev-wt2' }), undefined)
  // The server never inherits it: childEnv drops every TREK_ variable.
  assert.equal('TREK_LOCAL_PROFILE' in childEnv({ TREK_LOCAL_PROFILE: 'dev-wt2', PATH: '/bin' }), false)
  // Only the server's test endpoints for Linear and ElevenLabs get through (the smokes' stubs, 5b).
  assert.deepEqual(childEnv({ TREK_SERVER_LINEAR_URL: 'http://127.0.0.1:1/graphql', TREK_SERVER_ELEVENLABS_URL: 'http://127.0.0.1:1/v1', TREK_SERVER_GH: '/tmp/stub/gh', TREK_SERVER_OTHER: 'x' }), { TREK_SERVER_LINEAR_URL: 'http://127.0.0.1:1/graphql', TREK_SERVER_ELEVENLABS_URL: 'http://127.0.0.1:1/v1', TREK_SERVER_GH: '/tmp/stub/gh', ELECTRON_RUN_AS_NODE: '1' })
})

test('isLocalServerCommand: trek-server, start --local, and this profile\'s --local-profile', () => {
  const bundle = '/Users/u/Trek.app/Contents/MacOS/Trek /Users/u/Trek.app/Contents/Resources/app.asar/out/server/trek-server.cjs'
  assert.equal(isLocalServerCommand(`${bundle} start --local`, undefined), true)
  assert.equal(isLocalServerCommand(`${bundle} start --local --local-profile dev`, 'dev'), true)
  assert.equal(isLocalServerCommand('node /usr/local/bin/trek-server start --local', undefined), true, 'an installed CLI')
  assert.equal(isLocalServerCommand(`${bundle} start --local`, 'dev'), false, 'the default profile is not dev')
  assert.equal(isLocalServerCommand(`${bundle} start --local --local-profile dev`, undefined), false, 'dev is not the default profile')
  assert.equal(isLocalServerCommand(`${bundle} start --local --local-profile dev-wt2`, 'dev'), false, 'another named profile')
  assert.equal(isLocalServerCommand(`${bundle} stop --local`, undefined), false, 'a stop')
  assert.equal(isLocalServerCommand(`${bundle} start`, undefined), false, 'a remote server')
  assert.equal(isLocalServerCommand(`${bundle} start --localx`, undefined), false)
  assert.equal(isLocalServerCommand('sleep 300', undefined), false)
  assert.equal(isLocalServerCommand('/bin/zsh -c start --local', undefined), false, 'no trek-server')
  // 5a: main appends --import-env-from <userData> after the profile; ps prints it unquoted, spaces and all.
  const userData = '/Users/u/Library/Application Support/Trek Dev'
  for (const dir of [userData, `'${userData}'`]) {
    assert.equal(isLocalServerCommand(`${bundle} start --local --import-env-from ${dir}`, undefined), true, dir)
    assert.equal(isLocalServerCommand(`${bundle} start --local --import-env-from ${dir}`, 'dev'), false, dir)
    assert.equal(isLocalServerCommand(`${bundle} start --local --local-profile dev --import-env-from ${dir}`, 'dev'), true, dir)
    assert.equal(isLocalServerCommand(`${bundle} start --local --local-profile dev --import-env-from ${dir}`, undefined), false, dir)
  }
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
  assert.deepEqual(probeVerdict({ info, alive: true, welcome: { capabilities: ['local'], serverId: '' }, expectedServerId: 'srv-1' }), {
    use: false,
    why: 'the server on port 51234 is another profile ()'
  }, 'a welcome with no serverId is not this profile')
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

test('childEnv: no git location, Node path, npm or electron-vite dev variable; near-misses kept; the input unchanged', () => {
  const input = {
    PATH: '/bin',
    GIT_WORK_TREE: '/x',
    GIT_INDEX_FILE: '/x/.git/index',
    NODE_PATH: '/x/node_modules',
    NODE_ENV: 'development',
    NODE_ENV_ELECTRON_VITE: 'development',
    NO_SANDBOX: '1',
    REMOTE_DEBUGGING_PORT: '9222',
    INIT_CWD: '/x',
    NODE: '/usr/local/bin/node',
    npm_config_user_agent: 'npm/11',
    npm_lifecycle_event: 'dev',
    npm_package_name: 'trek-developer',
    npm_execpath: '/x/npm-cli.js',
    // Kept: case-sensitive, and a prefix includes its underscore.
    ELECTRON: 'x',
    ELECTRONIC: 'x',
    trek_x: 'x',
    TREKX: 'x',
    NPM_TOKEN: 'x',
    NODE_ENVX: 'x',
    GIT_AUTHOR_NAME: 'u'
  }
  const before = structuredClone(input)
  assert.deepEqual(childEnv(input), {
    PATH: '/bin',
    ELECTRON: 'x',
    ELECTRONIC: 'x',
    trek_x: 'x',
    TREKX: 'x',
    NPM_TOKEN: 'x',
    NODE_ENVX: 'x',
    GIT_AUTHOR_NAME: 'u',
    ELECTRON_RUN_AS_NODE: '1'
  })
  assert.deepEqual(input, before, 'the input is not changed')
  assert.equal('ELECTRON_RUN_AS_NODE' in input, false)
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
  assert.equal(afterStop({ code: 0, target: 4242, lockPid: undefined, infoPid: undefined, alive: false, holderIsServer: undefined }), 'spawn')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 4242, infoPid: 4242, alive: true, holderIsServer: true }), 'sigkill', 'a timeout: still running')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: undefined, infoPid: undefined, alive: false, holderIsServer: undefined }), 'spawn', 'gone by the time we look')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 4242, infoPid: 4242, alive: false, holderIsServer: undefined }), 'spawn', 'dead: the next start takes its files over')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 999, infoPid: 4242, alive: true, holderIsServer: true }), 'refuse', 'the lock is someone else\'s')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: undefined, infoPid: 4242, alive: true, holderIsServer: true }), 'refuse', 'lockless')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 4242, infoPid: 5555, alive: true, holderIsServer: true }), 'refuse', 'local.json moved on')
  assert.equal(afterStop({ code: 2, target: 4242, lockPid: 4242, infoPid: 4242, alive: true, holderIsServer: true }), 'refuse', 'a usage error is a bug: never kill on it')
})

test('afterStop: a stop that timed out, a stop that answered 0, and a target that is not our server', () => {
  const both = { target: 4242, lockPid: 4242, infoPid: 4242 }
  assert.equal(afterStop({ ...both, code: null, alive: true, holderIsServer: true }), 'refuse', 'stop --local never answered: never kill on it')
  assert.equal(afterStop({ ...both, code: null, alive: false, holderIsServer: undefined }), 'spawn', 'timed out, but gone')
  assert.equal(afterStop({ ...both, code: 0, alive: true, holderIsServer: true }), 'spawn', 'exit 0: its files are gone, it is on its way out')
  assert.equal(afterStop({ ...both, code: 1, alive: true, holderIsServer: false }), 'refuse', 'both files name it, but it is no server: a reused pid')
  assert.equal(afterStop({ ...both, code: 1, alive: true, holderIsServer: undefined }), 'refuse', 'ps could not tell')
})

test('resetDecision: the lock goes only when nothing that could be our server holds it', () => {
  // No lock: just start.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: undefined, lockAlive: false, info: undefined, welcomed: false, portRefused: true, holderIsServer: undefined }), 'start')
  // A server answers with local.json's token: it is live, connect to it.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info, welcomed: true, portRefused: false, holderIsServer: false }), 'connect')
  // The lock's pid is dead: the next start would take it over anyway.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: false, info, welcomed: false, portRefused: true, holderIsServer: undefined }), 'reset')
  // Alive, not a server by its command line, and local.json names another pid (or none): a reused pid.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info: undefined, welcomed: false, portRefused: true, holderIsServer: false }), 'reset')
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info: { ...info, pid: 77 }, welcomed: false, portRefused: false, holderIsServer: false }), 'reset')
  // Alive, not a server, local.json names it, and its port refuses: a SIGKILLed server's pid, reused.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info, welcomed: false, portRefused: true, holderIsServer: false }), 'reset')
  // Alive, named by local.json, its port open, but no welcome: the port says it may be our server. Never reset.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info, welcomed: false, portRefused: false, holderIsServer: false }), 'refuse')
  // A live pid's fresh lock: a start still on its way to local.json. Never reset.
  assert.equal(resetDecision({ lockAgeMs: 2_000, lockPid: 4242, lockAlive: true, info: undefined, welcomed: false, portRefused: true, holderIsServer: false }), 'refuse')
  assert.equal(resetDecision({ lockAgeMs: 2_000, lockPid: 4242, lockAlive: false, info: undefined, welcomed: false, portRefused: true, holderIsServer: undefined }), 'reset', 'dead: age does not matter')
})

test('resetDecision: a server, or a pid ps cannot read, keeps its lock; a timeout is not a refusal; the age boundary', () => {
  const live = { lockPid: 4242, lockAlive: true, lockAgeMs: 60_000, welcomed: false }
  // The holder's command line is our server: never reset, whatever local.json and the port say.
  assert.equal(resetDecision({ ...live, info, portRefused: true, holderIsServer: true }), 'refuse', 'our server, its port refusing')
  assert.equal(resetDecision({ ...live, info: undefined, portRefused: false, holderIsServer: true }), 'refuse', 'our server, local.json missing')
  assert.equal(resetDecision({ ...live, info: { ...info, pid: 77 }, portRefused: true, holderIsServer: true }), 'refuse', 'our server, local.json names another pid')
  // ps could not tell: refuse.
  assert.equal(resetDecision({ ...live, info: undefined, portRefused: false, holderIsServer: undefined }), 'refuse', 'unknown, local.json missing')
  assert.equal(resetDecision({ ...live, info, portRefused: true, holderIsServer: undefined }), 'refuse', 'unknown, its port refusing')
  // Not a server: local.json missing or naming another pid resets; naming it needs the port to refuse too.
  assert.equal(resetDecision({ ...live, info: undefined, portRefused: false, holderIsServer: false }), 'reset')
  assert.equal(resetDecision({ ...live, info, portRefused: true, holderIsServer: false }), 'reset')
  // A timeout (a hung server, a full backlog) counts as not refused: refuse.
  assert.equal(resetDecision({ ...live, info, portRefused: false, holderIsServer: false }), 'refuse', 'the port timed out')
  // A young lock whose pid local.json names, its port refusing: a start on its way. Refuse.
  assert.equal(resetDecision({ ...live, lockAgeMs: 2_000, info, portRefused: true, holderIsServer: false }), 'refuse')
  // The boundary: READY_TIMEOUT_MS old may be judged; a lock dated in the future (or unreadable age) may not.
  assert.equal(READY_TIMEOUT_MS, 15_000)
  assert.equal(resetDecision({ ...live, lockAgeMs: 15_000, info: undefined, portRefused: false, holderIsServer: false }), 'reset')
  assert.equal(resetDecision({ ...live, lockAgeMs: 14_999, info: undefined, portRefused: false, holderIsServer: false }), 'refuse')
  assert.equal(resetDecision({ ...live, lockAgeMs: -5_000, info: undefined, portRefused: false, holderIsServer: false }), 'refuse', 'dated in the future')
  assert.equal(resetDecision({ ...live, lockAgeMs: Number.NaN, info: undefined, portRefused: false, holderIsServer: false }), 'refuse')
})

test('sameFile: device, inode and ctime all match', () => {
  const a = { dev: 1, ino: 2, ctimeMs: 3 }
  assert.equal(sameFile(a, { ...a }), true)
  assert.equal(sameFile(a, { ...a, dev: 9 }), false)
  assert.equal(sameFile(a, { ...a, ino: 9 }), false)
  assert.equal(sameFile(a, { ...a, ctimeMs: 3.5 }), false, 'rewritten in place')
})

test('logTail: the last lines, trimmed; rotation past 1 MB', () => {
  assert.equal(logTail('a\nb\nc\n\n', 2), 'b\nc')
  assert.equal(logTail('', 5), '')
  const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  assert.equal(logTail(many), Array.from({ length: 20 }, (_, i) => `line ${i + 10}`).join('\n'), 'the default is 20')
  assert.equal(logTail('a\n   \n\t\nb\n \n', 5), 'a\nb', 'whitespace-only lines are dropped')
  assert.equal(logTail('a\r\nb\r\n\r\nc\r\n', 2), 'b\nc', 'CRLF')
  assert.equal(LOG_ROTATE_BYTES, 1024 * 1024)
})

test('TREK_NO_LOCAL_SERVER: on only as 1, true or yes', () => {
  for (const on of ['1', 'true', 'yes', 'TRUE', ' Yes ']) assert.equal(localServerDisabled({ TREK_NO_LOCAL_SERVER: on }), true, JSON.stringify(on))
  for (const off of [undefined, '', '0', 'false', 'no', 'off', '2', 'y']) assert.equal(localServerDisabled({ TREK_NO_LOCAL_SERVER: off }), false, JSON.stringify(off))
  assert.equal(localServerDisabled({}), false)
})

test("lostRaceDeadline: the loser of the lock waits out the winner's start, from the lock's mtime", () => {
  const now = 1_000_000
  assert.ok(READY_TIMEOUT_MS >= 15_000, 'as long as a start may take')
  assert.equal(lostRaceDeadline(now, now), now + READY_TIMEOUT_MS, 'a lock just taken: the full ready timeout')
  assert.equal(lostRaceDeadline(now, now - 4_000), now - 4_000 + READY_TIMEOUT_MS, 'one taken 4 s ago: the rest of it')
  assert.ok(lostRaceDeadline(now, now - 4_000) - now > 8_000, 'more than the old 8 s')
  assert.equal(lostRaceDeadline(now, now - 120_000), now + LOST_RACE_MIN_WAIT_MS, 'an old lock: a short grace only')
  assert.equal(lostRaceDeadline(now, now + 60_000), now + READY_TIMEOUT_MS, 'a lock dated in the future counts as now')
  assert.equal(lostRaceDeadline(now, undefined), now + READY_TIMEOUT_MS, 'no lock read')
  assert.equal(lostRaceDeadline(now, Number.NaN), now + READY_TIMEOUT_MS)
  // Waiting until then means Reset no longer refuses the lock as young.
  const deadline = lostRaceDeadline(now, now - 1_000)
  assert.equal(resetDecision({ lockPid: 9, lockAlive: true, lockAgeMs: deadline - (now - 1_000), info: undefined, welcomed: false, portRefused: false, holderIsServer: false }), 'reset')
})

test('keepAfterFailure: a failed stop or restart keeps a server local.json still names alive', () => {
  const cur = { pid: 4242, port: 51234, token: 't' }
  assert.equal(keepAfterFailure({ op: 'stop', current: cur, info: { ...cur }, alive: true }), true)
  assert.equal(keepAfterFailure({ op: 'restart', current: cur, info: { ...cur }, alive: true }), true)
  assert.equal(keepAfterFailure({ op: 'start', current: cur, info: { ...cur }, alive: true }), false, 'a start')
  assert.equal(keepAfterFailure({ op: 'stop', current: cur, info: { ...cur }, alive: false }), false, 'its pid is gone')
  assert.equal(keepAfterFailure({ op: 'stop', current: cur, info: undefined, alive: false }), false, 'local.json went')
  assert.equal(keepAfterFailure({ op: 'stop', current: null, info: { ...cur }, alive: true }), false, 'none in use')
  assert.equal(keepAfterFailure({ op: 'stop', current: cur, info: { ...cur, pid: 1 }, alive: true }), false, 'another pid')
  assert.equal(keepAfterFailure({ op: 'stop', current: cur, info: { ...cur, port: 1 }, alive: true }), false, 'another port')
  assert.equal(keepAfterFailure({ op: 'restart', current: cur, info: { ...cur, token: 'u' }, alive: true }), false, 'another token')
})
