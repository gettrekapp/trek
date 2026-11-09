// scripts/serverMachine.test.mjs — docker.*, env.*, stack.* and worktree.dirty (phase 5a), against
// real git in a temp dir and stub docker, colima and stack.sh: nothing here runs a real docker or
// colima. Each stub records its arguments and working directory.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { createEventSink } from '../server/src/integrations/machineHandlers.ts'
import { createEnvironmentService } from '../src/host/environmentService.ts'
import { createStackService } from '../src/host/stackService.ts'
import { deriveProfileName, envListProblem } from '../src/shared/environments.ts'
import { ClientError } from '../src/shared/client/connection.ts'

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })

// The stubs, first on PATH for the whole file (node --test runs each file in its own process).
const stubDir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-stubs-')))
const callsFile = join(stubDir, 'calls')
const stub = (name, body) => {
  writeFileSync(join(stubDir, name), `#!/bin/bash\necho "${name}|$PWD|$*|FOO=$FOO" >> '${callsFile}'\n${body}\n`)
  chmodSync(join(stubDir, name), 0o755)
}
stub('docker', `case "$1" in
  --version) echo "Docker version 0.0.0-stub" ;;
  ps) if [ "$2" = "-a" ]; then echo '{"ID":"c1","Names":"web","Image":"nginx","State":"running","Status":"Up 1 minute","Ports":"80/tcp"}'; fi ;;
esac
case " $* " in *" compose "*" ps "*) echo '[{"Service":"web","State":"running","Status":"Up","Publishers":[{"PublishedPort":8080,"TargetPort":80,"Protocol":"tcp"}]}]' ;; esac
case " $* " in *" logs "*) echo "web log line" ;; esac
exit 0`)
stub('colima', `case "$1" in
  --version) echo "colima version 0.0.0-stub" ;;
  list) [ -f '${stubDir}/vms' ] && cat '${stubDir}/vms' ;;
esac
exit 0`)
const originalPath = process.env.PATH
process.env.PATH = `${stubDir}:${originalPath}`
process.on('exit', () => rmSync(stubDir, { recursive: true, force: true }))

const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : [])
const resetCalls = () => rmSync(callsFile, { force: true })

async function setup(t, options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-machine-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  resetCalls()
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  mkdirSync(join(a, 'docker', 'stack'), { recursive: true })
  writeFileSync(join(a, 'docker', 'stack', 'stack.sh'), `#!/bin/bash\necho "stack|$PWD|$*" >> '${callsFile}'\n${options.stackBody ?? ''}\n`, { mode: 0o755 })
  writeFileSync(join(a, 'docker-compose.yml'), 'services: {}\n')
  writeFileSync(join(a, 'compose.dev.yaml'), 'services: {}\n')
  git(a, 'add', '.')
  git(a, 'commit', '-q', '-m', 'init')
  git(a, 'worktree', 'add', '-q', '-b', 'feature-x', `${a}-feature-x`)
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
  const data = join(dir, 'data')
  mkdirSync(data)
  const machine = {
    env: createEnvironmentService({ registryFile: join(data, 'environments.json'), home: dir }),
    stacks: createStackService({ stateDir: join(data, 'stacks') })
  }
  const events = []
  const ctx = { store, hub, subscriber: { send: () => {} }, projects, poller, sessions: { blockPath: () => () => {}, refreshAttention: () => {} }, machine, events: { send: (event, payload) => events.push([event, payload]) } }
  const call = (method, params) => dispatchV2(method, params, ctx)
  /** Another connection to the same server: its own event sink, the same machine. */
  const connection = () => {
    const own = []
    const other = { ...ctx, events: { send: (event, payload) => own.push([event, payload]) } }
    return { events: own, call: (method, params) => dispatchV2(method, params, other) }
  }
  const created = await call('project.create', { name: 'P', repositories: [{ path: a }] })
  const projectId = created.result.projectId
  await poller.refresh(a)
  const repo = () => projects.require(projectId).repositories[0]
  const worktreeAt = (path) => repo().worktrees.find((w) => w.path === path)
  return { dir, a, feature: `${a}-feature-x`, data, store, projects, call, connection, events, projectId, repoId: repo().id, repo, worktreeAt, ctx }
}

const refused = (res, code, reason) => {
  assert.equal(res.ok, false, JSON.stringify(res))
  assert.equal(res.error.code, code, res.error.message)
  if (reason !== undefined) assert.equal(res.error.details?.reason, reason)
}

test('docker.list, docker.container and docker.compose run docker on the server, compose in the main checkout', async (t) => {
  const s = await setup(t)
  const list = await s.call('docker.list', {})
  assert.deepEqual(list.result, [{ id: 'c1', name: 'web', image: 'nginx', state: 'running', status: 'Up 1 minute', ports: '80/tcp' }])
  assert.equal((await s.call('docker.container', { action: 'restart', id: 'c1' })).ok, true)
  const compose = await s.call('docker.compose', { projectId: s.projectId, repoId: s.repoId, action: 'upBuild' })
  assert.equal(compose.result, 0)
  assert.deepEqual(calls().filter((c) => !c.includes('|ps -a')), [`docker|${process.cwd()}|restart c1|FOO=`, `docker|${s.a}|compose up --build -d|FOO=`])
  // The output went to this connection as docker.log, the last one marked done.
  assert.equal(s.events.every(([event]) => event === 'docker.log'), true)
  assert.equal(s.events[0][1].data, '$ docker compose up --build -d\n')
  assert.equal(s.events.at(-1)[1].done, true)
})

test('docker: an action, a container id or a repository the server does not know is refused before docker runs', async (t) => {
  const s = await setup(t)
  for (const id of ['-rf', 'a b', 'a;rm -rf /', '', '$(id)', 'x'.repeat(300)]) refused(await s.call('docker.container', { action: 'stop', id }), 'BAD_REQUEST')
  refused(await s.call('docker.container', { action: 'rm', id: 'c1' }), 'BAD_REQUEST')
  refused(await s.call('docker.compose', { projectId: s.projectId, repoId: s.repoId, action: 'up -d; echo' }), 'BAD_REQUEST')
  refused(await s.call('docker.compose', { projectId: s.projectId, repoId: s.repoId, args: ['rm', '-f'] }), 'BAD_REQUEST')
  refused(await s.call('docker.compose', { projectId: s.projectId, repoId: 'nope', action: 'up' }), 'NOT_FOUND')
  assert.deepEqual(calls(), [])
})

test('a machine without docker or colima: TOOL_ERROR with reason missing, and env.check says so', async (t) => {
  const s = await setup(t)
  const empty = mkdtempSync(join(tmpdir(), 'trek-machine-nopath-'))
  process.env.PATH = empty
  t.after(() => {
    process.env.PATH = `${stubDir}:${originalPath}`
    rmSync(empty, { recursive: true, force: true })
  })
  refused(await s.call('docker.list', {}), 'TOOL_ERROR', 'missing')
  refused(await s.call('docker.container', { action: 'start', id: 'c1' }), 'TOOL_ERROR', 'missing')
  refused(await s.call('env.list', { projectId: s.projectId, repoId: s.repoId }), 'TOOL_ERROR', 'missing')
  const check = await s.call('env.check', {})
  assert.deepEqual([check.ok, check.result.ok, check.result.error], [true, false, 'colima not found on PATH — brew install colima'])
  // A compose run with no docker ends with -1 and says why in its output; nothing crashes.
  assert.equal((await s.call('docker.compose', { projectId: s.projectId, repoId: s.repoId, action: 'up' })).result, -1)
  assert.match(s.events.map(([, e]) => e.data).join(''), /error: spawn docker ENOENT/)
  // Exactly one done event, though the child reports both error and close.
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(s.events.filter(([, e]) => e.done).length, 1)
})

test("env.up starts the branch's VM under the repository's envRepoKey, with the checked settings and variables", async (t) => {
  const s = await setup(t)
  // An imported repository keeps the path its VMs were named after.
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].environments = { enabled: true, profileKey: '/old/spelling/a' }
  })
  const worktreeId = s.worktreeAt(s.feature).id
  const profile = deriveProfileName('/old/spelling/a', 'feature-x')
  const res = await s.call('env.up', {
    projectId: s.projectId,
    worktreeId,
    settings: { enabled: true, cpu: 3, memory: 6, networkAddress: false, composeFile: 'docker-compose.yml', profileKey: '/elsewhere' },
    envVars: { FOO: 'bar' }
  })
  assert.deepEqual(res.result, { code: 0, address: undefined })
  assert.deepEqual(calls(), [
    `colima|${process.cwd()}|start ${profile} --cpu 3 --memory 6 --disk 20|FOO=`,
    `docker|${s.feature}|--context colima-${profile} compose -f docker-compose.yml up -d|FOO=bar`,
    `colima|${process.cwd()}|list --json|FOO=`
  ])
  const registry = JSON.parse(readFileSync(join(s.data, 'environments.json'), 'utf8'))
  assert.deepEqual(Object.keys(registry), [profile])
  assert.deepEqual([registry[profile].repoPath, registry[profile].branch, registry[profile].worktreePath, registry[profile].envVars], ['/old/spelling/a', 'feature-x', s.feature, { FOO: 'bar' }])
  assert.equal(statSync(join(s.data, 'environments.json')).mode & 0o777, 0o600)
  const steps = s.events.filter(([event, e]) => event === 'env.log' && e.step).map(([, e]) => e.step)
  assert.deepEqual(steps, ['vm', 'compose', 'ready'])
  assert.equal(s.events.every(([event, e]) => event === 'env.log' && e.profile === profile), true)
  // The list names it under the same key; ps and logs read its compose project.
  writeFileSync(join(stubDir, 'vms'), `${JSON.stringify({ name: profile, status: 'Running', address: '10.0.0.5' })}\n${JSON.stringify({ name: 'twb-leftover-000000', status: 'Stopped' })}\n`)
  t.after(() => rmSync(join(stubDir, 'vms'), { force: true }))
  const list = (await s.call('env.list', { projectId: s.projectId, repoId: s.repoId })).result
  assert.deepEqual(list.map((e) => [e.profile, e.vmState, e.address, e.orphaned]), [[profile, 'running', '10.0.0.5', undefined], ['twb-leftover-000000', 'stopped', undefined, true]])
  assert.deepEqual((await s.call('env.ps', { projectId: s.projectId, worktreeId })).result, [{ name: 'web', state: 'running', status: 'Up', ports: [{ published: 8080, target: 80, protocol: 'tcp' }] }])
  assert.equal((await s.call('env.logs', { projectId: s.projectId, worktreeId, service: 'web', tail: 50 })).result, 'web log line\n')
  assert.deepEqual((await s.call('env.composeFiles', { projectId: s.projectId, worktreeId })).result, ['compose.dev.yaml', 'docker-compose.yml'])
})

test('env.up refuses settings, compose files and variables that would steer the run, before colima runs', async (t) => {
  const s = await setup(t)
  const worktreeId = s.worktreeAt(s.feature).id
  const up = (extra) => s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true }, ...extra })
  for (const composeFile of ['../outside.yml', '/etc/passwd', '-f /etc/x', 'a/../../b.yml', 'ok.yml,../x.yml', 'x\0.yml', '.']) {
    refused(await up({ settings: { enabled: true, composeFile } }), 'BAD_REQUEST')
  }
  for (const settings of [{ enabled: true, cpu: 0 }, { enabled: true, memory: 1.5 }, { enabled: true, disk: '20' }, { enabled: true, rosetta: 'yes' }, { enabled: true, extra: 1 }, 'x', null]) {
    refused(await up({ settings }), 'BAD_REQUEST')
  }
  for (const envVars of [{ PATH: '/tmp' }, { LD_PRELOAD: 'x.so' }, { DYLD_INSERT_LIBRARIES: 'x' }, { DOCKER_HOST: 'tcp://x' }, { 'A B': '1' }, { '1X': '1' }, { X: 1 }, { X: 'a\0b' }, ['X=1']]) {
    refused(await up({ envVars }), 'BAD_REQUEST')
  }
  // The names that steer docker compose or the server's own files, by family and in any case.
  for (const name of ['HOME', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'COMPOSE_PROJECT_NAME', 'COMPOSE_ENV_FILES', 'BUILDKIT_X', 'XDG_CONFIG_HOME', 'path', 'Docker_Host', 'ld_preload']) {
    const res = await up({ envVars: { API_URL: 'http://x', [name]: 'x' } })
    refused(res, 'BAD_REQUEST')
    assert.match(res.error.message, new RegExp(`envVars: ${name} cannot be set`))
  }
  // A symlink in the worktree that leads outside it is refused like a ".." path.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-outside-')))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'evil.yml'), 'services: {}\n')
  symlinkSync(join(outside, 'evil.yml'), join(s.feature, 'evil.yml'))
  symlinkSync(outside, join(s.feature, 'outdir'))
  for (const composeFile of ['evil.yml', 'outdir/evil.yml', 'docker-compose.yml,evil.yml']) {
    refused(await up({ settings: { enabled: true, composeFile } }), 'BAD_REQUEST')
    refused(await s.call('env.ps', { projectId: s.projectId, worktreeId, composeFile }), 'BAD_REQUEST')
    refused(await s.call('env.logs', { projectId: s.projectId, worktreeId, service: 'web', composeFile }), 'BAD_REQUEST')
  }
  for (const composeFile of ['../outside.yml', '/etc/passwd', '-f']) {
    refused(await s.call('env.ps', { projectId: s.projectId, worktreeId, composeFile }), 'BAD_REQUEST')
    refused(await s.call('env.logs', { projectId: s.projectId, worktreeId, service: 'web', composeFile }), 'BAD_REQUEST')
  }
  refused(await s.call('env.up', { projectId: s.projectId, worktreeId: 'nope', settings: { enabled: true } }), 'NOT_FOUND')
  for (const profile of ['../x', 'twb-', '-rf', 'other-vm', 'twb-A', 'twb-a b']) {
    refused(await s.call('env.stop', { profile }), 'BAD_REQUEST')
    refused(await s.call('env.destroy', { profile }), 'BAD_REQUEST')
  }
  refused(await s.call('env.logs', { projectId: s.projectId, worktreeId, service: '-f' }), 'BAD_REQUEST')
  refused(await s.call('env.logs', { projectId: s.projectId, worktreeId, service: 'web', tail: 1e9 }), 'BAD_REQUEST')
  assert.deepEqual(calls(), [])
  assert.equal(existsSync(join(s.data, 'environments.json')), false)
  // An ordinary name still passes, and a symlink that stays inside the worktree is fine.
  symlinkSync(join(s.feature, 'docker-compose.yml'), join(s.feature, 'linked.yml'))
  assert.equal((await up({ settings: { enabled: true, networkAddress: false, composeFile: 'linked.yml' }, envVars: { API_URL: 'http://x' } })).result.code, 0)
})

test('env.destroy deletes the VM and its registry entry; two environments started at once both stay registered', async (t) => {
  const s = await setup(t)
  git(s.a, 'worktree', 'add', '-q', '-b', 'feature-y', `${s.a}-feature-y`)
  await s.ctx.poller.refresh(s.a)
  const [x, y] = [s.worktreeAt(s.feature).id, s.worktreeAt(`${s.a}-feature-y`).id]
  const results = await Promise.all([x, y].map((worktreeId) => s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })))
  assert.deepEqual(results.map((r) => r.result.code), [0, 0])
  const px = deriveProfileName(s.a, 'feature-x')
  const py = deriveProfileName(s.a, 'feature-y')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(s.data, 'environments.json'), 'utf8'))).sort(), [px, py].sort())
  resetCalls()
  assert.equal((await s.call('env.destroy', { profile: px })).result, 0)
  assert.deepEqual(calls(), [`docker|${s.feature}|--context colima-${px} compose -f docker-compose.yml down -v|FOO=`, `colima|${process.cwd()}|delete ${px} --force|FOO=`])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(s.data, 'environments.json'), 'utf8'))), [py])
  assert.equal((await s.call('env.stop', { profile: py })).result, 0)
})

test("stack.*: the worktree's stack.sh, by the server's own path; its state in the data dir", async (t) => {
  const s = await setup(t, { stackBody: 'if [ "$1" = up ]; then sleep 30; fi' })
  const worktreeId = s.worktreeAt(s.feature).id
  const ref = { projectId: s.projectId, worktreeId }
  const status = (await s.call('stack.status', ref)).result
  assert.deepEqual([status.available, status.slug, status.upRunning, status.created], [true, 'a-feature-x', false, false])
  assert.equal((await s.call('stack.up', { ...ref, starter: true })).ok, true)
  assert.equal(existsSync(join(s.data, 'stacks', 'a-feature-x.pid')), true)
  assert.equal((await s.call('stack.status', ref)).result.upRunning, true)
  refused(await s.call('stack.up', { ...ref, starter: false }), 'TOOL_ERROR')
  // Down Ctrl-C's the running up first, then runs `stack.sh down`.
  assert.equal((await s.call('stack.down', ref)).result, 0)
  assert.equal((await s.call('stack.status', ref)).result.upRunning, false)
  assert.deepEqual(calls().filter((c) => c.startsWith('stack|')), [`stack|${s.feature}|up --starter`, `stack|${s.feature}|down`])
  const log = (await s.call('stack.log', { ...ref, fileId: 0, offset: 0 })).result
  assert.match(log.text, /\$ stack\.sh up --starter\n\$ stack\.sh down\n/)
  assert.deepEqual((await s.call('stack.log', { ...ref, fileId: log.fileId, offset: log.offset })).result.text, '')
  for (const bad of [{ fileId: -1, offset: 0 }, { fileId: 0, offset: 1.5 }, { fileId: '0', offset: 0 }]) refused(await s.call('stack.log', { ...ref, ...bad }), 'BAD_REQUEST')
  refused(await s.call('stack.up', { ...ref, starter: 'yes' }), 'BAD_REQUEST')
  assert.equal((await s.call('stack.destroy', ref)).result, 0)
  // The main checkout has its own stack: the repository's.
  const main = s.repo().worktrees.find((w) => w.isMain)
  assert.deepEqual((await s.call('stack.status', { projectId: s.projectId, worktreeId: main.id })).result.slug, 'a')
})

test('worktree.dirty reads git afresh; a worktree outside the allowlist is PATH_DENIED for every machine method', async (t) => {
  const s = await setup(t)
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  assert.equal((await s.call('worktree.dirty', ref)).result, false)
  writeFileSync(join(s.feature, 'scratch.txt'), 'x\n')
  assert.equal((await s.call('worktree.dirty', ref)).result, true)
  // A row the guard does not cover (a hand-edited project file, say).
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-outside-')))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees.push({ id: 'out', name: 'out', path: outside, branch: 'feature-x', isMain: false, loaded: false, sessions: [] })
  })
  const out = { projectId: s.projectId, worktreeId: 'out' }
  for (const [method, extra] of [['worktree.dirty', {}], ['stack.status', {}], ['stack.up', { starter: false }], ['stack.down', {}], ['stack.destroy', {}], ['stack.log', { fileId: 0, offset: 0 }], ['env.ps', {}], ['env.composeFiles', {}], ['env.logs', { service: 'web' }], ['env.up', { settings: { enabled: true } }]]) {
    refused(await s.call(method, { ...out, ...extra }), 'PATH_DENIED')
  }
  assert.deepEqual(calls(), [])
})

test('a filesystem ENOENT is a TOOL_ERROR, not a missing tool; only a failed spawn is', async (t) => {
  const s = await setup(t)
  const fsError = Object.assign(new Error("ENOENT: no such file or directory, open '/data/stacks/a.log'"), { code: 'ENOENT', syscall: 'open', path: '/data/stacks/a.log' })
  s.ctx.machine = { ...s.ctx.machine, stacks: { ...s.ctx.machine.stacks, log: () => Promise.reject(fsError) } }
  const res = await s.call('stack.log', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, fileId: 0, offset: 0 })
  refused(res, 'TOOL_ERROR')
  assert.equal(res.error.details?.reason, undefined)
  assert.match(res.error.message, /ENOENT: no such file/)
})

test('stack.sh is refused when its real path leaves the worktree; the outside script never runs', async (t) => {
  const s = await setup(t)
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-outside-')))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const outsideScript = `#!/bin/bash\necho "outside|$*" >> '${callsFile}'\n`
  writeFileSync(join(outside, 'stack.sh'), outsideScript, { mode: 0o755 })
  const script = join(s.feature, 'docker', 'stack', 'stack.sh')
  unlinkSync(script)
  symlinkSync(join(outside, 'stack.sh'), script)
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  for (const [method, extra] of [['stack.up', { starter: false }], ['stack.down', {}], ['stack.destroy', {}]]) {
    const res = await s.call(method, { ...ref, ...extra })
    refused(res, 'TOOL_ERROR')
    assert.match(res.error.message, /outside the worktree/)
  }
  // A directory symlink that leads outside is refused too.
  rmSync(join(s.feature, 'docker'), { recursive: true, force: true })
  mkdirSync(join(outside, 'docker', 'stack'), { recursive: true })
  writeFileSync(join(outside, 'docker', 'stack', 'stack.sh'), outsideScript, { mode: 0o755 })
  symlinkSync(join(outside, 'docker'), join(s.feature, 'docker'))
  refused(await s.call('stack.up', { ...ref, starter: false }), 'TOOL_ERROR')
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(calls(), [])
})

test("stack.up: a second up while one is starting is refused; a run that exits leaves a later run's pid file alone", async (t) => {
  const s = await setup(t, { stackBody: 'if [ "$1" = up ]; then sleep 0.5; fi' })
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  const results = await Promise.all([s.call('stack.up', { ...ref, starter: false }), s.call('stack.up', { ...ref, starter: false })])
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true])
  refused(results.find((r) => !r.ok), 'TOOL_ERROR')
  // A later run's pid (this process, which is alive) replaced the file before the first run exits.
  const pidPath = join(s.data, 'stacks', 'a-feature-x.pid')
  writeFileSync(pidPath, String(process.pid))
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(readFileSync(pidPath, 'utf8'), String(process.pid))
  rmSync(pidPath)
  assert.equal(calls().filter((c) => c.startsWith('stack|')).length, 1)
})

test('the registry: a file that cannot be read is never overwritten; a leftover temp file does not loosen 0600', async (t) => {
  const s = await setup(t)
  const registryFile = join(s.data, 'environments.json')
  const worktreeId = s.worktreeAt(s.feature).id
  const up = () => s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })
  const torn = '{"twb-kept-000000": {"repoPath": "/x"'
  writeFileSync(registryFile, torn)
  const res = await up()
  assert.equal(res.result.code, -1)
  assert.match(res.result.error, /environments registry .* cannot be read/)
  assert.equal(readFileSync(registryFile, 'utf8'), torn)
  assert.deepEqual(calls(), [])
  // A leftover temp file from a crashed write, world-readable.
  rmSync(registryFile)
  writeFileSync(`${registryFile}.${process.pid}.tmp`, 'stale')
  chmodSync(`${registryFile}.${process.pid}.tmp`, 0o644)
  assert.equal((await up()).result.code, 0)
  assert.equal(statSync(registryFile).mode & 0o777, 0o600)
})

test('env.destroy skips docker compose for a registry entry outside the allowlist, and still deletes the VM', async (t) => {
  const s = await setup(t)
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-outside-')))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'docker-compose.yml'), 'services: {}\n')
  const profile = 'twb-imported-000000'
  writeFileSync(join(s.data, 'environments.json'), JSON.stringify({ [profile]: { repoPath: s.a, branch: 'x', worktreePath: outside, createdAt: 'then' } }))
  assert.equal((await s.call('env.destroy', { profile })).result, 0)
  assert.deepEqual(calls(), [`colima|${process.cwd()}|delete ${profile} --force|FOO=`])
  assert.match(s.events.map(([, e]) => e.data).join(''), /skipping docker compose down/)
  assert.deepEqual(JSON.parse(readFileSync(join(s.data, 'environments.json'), 'utf8')), {})
})

test("env.up refuses a worktree outside Colima's home on a path boundary (/x/rep is not /x/repos)", async (t) => {
  const s = await setup(t)
  // A home that is a string prefix of the worktree's path but not one of its directories.
  s.ctx.machine = { ...s.ctx.machine, env: createEnvironmentService({ registryFile: join(s.data, 'environments.json'), home: join(s.dir, 'rep') }) }
  const res = await s.call('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true } })
  assert.equal(res.result.code, -1)
  assert.match(res.result.error, /outside the home directory/)
  assert.deepEqual(calls(), [])
})

test("a run's events reach only the connection that asked for it", async (t) => {
  const s = await setup(t)
  const other = s.connection()
  const worktreeId = s.worktreeAt(s.feature).id
  await Promise.all([
    other.call('docker.compose', { projectId: s.projectId, repoId: s.repoId, action: 'pull' }),
    s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })
  ])
  assert.ok(other.events.length > 0 && s.events.length > 0)
  assert.equal(other.events.every(([event]) => event === 'docker.log'), true)
  assert.equal(s.events.every(([event]) => event === 'env.log'), true)
})

test('the event sink drops log chunks past the high-water mark, says so once it drains, and never drops a step or done', () => {
  const sent = []
  let buffered = 0
  const sink = createEventSink((event, payload) => sent.push([event, payload]), () => buffered)
  sink.send('docker.log', { data: 'a' })
  buffered = 64 * 1024 * 1024
  sink.send('docker.log', { data: 'lost' })
  sink.send('env.log', { profile: 'twb-p', data: 'lost' })
  sink.send('env.log', { profile: 'twb-p', data: '', step: 'compose' })
  sink.send('docker.log', { data: 'end', done: true })
  buffered = 0
  sink.send('env.log', { profile: 'twb-p', data: 'b' })
  sink.send('docker.log', { data: 'c' })
  const dropped = '[output dropped: the connection fell behind]\n'
  assert.deepEqual(sent, [
    ['docker.log', { data: 'a' }],
    ['env.log', { profile: 'twb-p', data: '', step: 'compose' }],
    ['docker.log', { data: dropped }],
    ['docker.log', { data: 'end', done: true }],
    ['env.log', { profile: 'twb-p', data: dropped }],
    ['env.log', { profile: 'twb-p', data: 'b' }],
    ['docker.log', { data: 'c' }]
  ])
})

test('stack.down and stack.destroy are refused while an up is starting, so the start cannot bring containers up after them', async (t) => {
  const s = await setup(t, { stackBody: 'if [ "$1" = up ]; then sleep 30; fi' })
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  for (const method of ['stack.down', 'stack.destroy']) {
    const [up, stop] = await Promise.all([s.call('stack.up', { ...ref, starter: false }), s.call(method, ref)])
    assert.equal(up.ok, true, JSON.stringify(up))
    refused(stop, 'TOOL_ERROR')
    assert.match(stop.error.message, /is starting/)
    // Once started, down stops it.
    assert.equal((await s.call('stack.down', ref)).result, 0)
  }
})

test('env.list: a registry file that cannot be read is a TOOL_ERROR naming it, not a list of orphans', async (t) => {
  const s = await setup(t)
  const registryFile = join(s.data, 'environments.json')
  writeFileSync(join(stubDir, 'vms'), `${JSON.stringify({ name: 'twb-real-000000', status: 'Running' })}\n`)
  t.after(() => rmSync(join(stubDir, 'vms'), { force: true }))
  for (const text of ['{"twb-real-000000": {', '[]']) {
    writeFileSync(registryFile, text)
    const res = await s.call('env.list', { projectId: s.projectId, repoId: s.repoId })
    refused(res, 'TOOL_ERROR', 'registry')
    assert.ok(res.error.message.includes(registryFile), res.error.message)
    // The client shows it (the Env panel, Settings) rather than keeping the last list quietly.
    assert.equal(envListProblem(new ClientError(res.error.code, res.error.message, res.error.details)), res.error.message)
    assert.equal(readFileSync(registryFile, 'utf8'), text)
  }
  // No file is an empty registry: the VM is a leftover.
  rmSync(registryFile)
  assert.deepEqual((await s.call('env.list', { projectId: s.projectId, repoId: s.repoId })).result.map((e) => [e.profile, e.orphaned]), [['twb-real-000000', true]])
})
