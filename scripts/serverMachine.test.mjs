// scripts/serverMachine.test.mjs — docker.*, stack.*, worktree.dirty and a worktree's teardown of
// its dev stack and VM (phase 5a, plugins E1), against real git in a temp dir and the stub docker,
// colima and stack.sh of scripts/machineHarness.mjs: nothing here runs a real docker or colima.
// The env.* methods are the Colima plugin's since plugins E2 (scripts/colimaPlugin.test.mjs); the
// tests here reach its VM through the harness's registry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchV2 } from '../server/src/v2.ts'
import { createEventSink } from '../server/src/integrations/machineHandlers.ts'
import { holdWorktree } from '../server/src/teardown/teardown.ts'
import { createStackService } from '../src/host/stackService.ts'
import { deriveProfileName } from '../plugins/colima/shared/environments.ts'
import { removeDir } from './testPlatform.mjs'
import { calls, callsFile, git, gitEnv, originalPath, refused, resetCalls, setup, skip, stubDir } from './machineHarness.mjs'

test('docker.list, docker.container and docker.compose run docker on the server, compose in the main checkout', { skip }, async (t) => {
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

test('docker: an action, a container id or a repository the server does not know is refused before docker runs', { skip }, async (t) => {
  const s = await setup(t)
  for (const id of ['-rf', 'a b', 'a;rm -rf /', '', '$(id)', 'x'.repeat(300)]) refused(await s.call('docker.container', { action: 'stop', id }), 'BAD_REQUEST')
  refused(await s.call('docker.container', { action: 'rm', id: 'c1' }), 'BAD_REQUEST')
  refused(await s.call('docker.compose', { projectId: s.projectId, repoId: s.repoId, action: 'up -d; echo' }), 'BAD_REQUEST')
  refused(await s.call('docker.compose', { projectId: s.projectId, repoId: s.repoId, args: ['rm', '-f'] }), 'BAD_REQUEST')
  refused(await s.call('docker.compose', { projectId: s.projectId, repoId: 'nope', action: 'up' }), 'NOT_FOUND')
  assert.deepEqual(calls(), [])
})

test('a machine without docker or colima: TOOL_ERROR with reason missing, and env.check says so', { skip }, async (t) => {
  const s = await setup(t)
  const empty = mkdtempSync(join(tmpdir(), 'trek-machine-nopath-'))
  process.env.PATH = empty
  t.after(() => {
    process.env.PATH = `${stubDir}:${originalPath}`
    removeDir(empty)
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

test("stack.*: the worktree's stack.sh, by the server's own path; its state in the data dir", { skip }, async (t) => {
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

test('worktree.dirty reads git afresh; a worktree outside the allowlist is PATH_DENIED for every machine method', { skip }, async (t) => {
  const s = await setup(t)
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  assert.equal((await s.call('worktree.dirty', ref)).result, false)
  writeFileSync(join(s.feature, 'scratch.txt'), 'x\n')
  assert.equal((await s.call('worktree.dirty', ref)).result, true)
  // A row the guard does not cover (a hand-edited project file, say).
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-outside-')))
  t.after(() => removeDir(outside))
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees.push({ id: 'out', name: 'out', path: outside, branch: 'feature-x', isMain: false, loaded: false, sessions: [] })
  })
  const out = { projectId: s.projectId, worktreeId: 'out' }
  for (const [method, extra] of [['worktree.dirty', {}], ['stack.status', {}], ['stack.up', { starter: false }], ['stack.down', {}], ['stack.destroy', {}], ['stack.log', { fileId: 0, offset: 0 }], ['env.ps', {}], ['env.composeFiles', {}], ['env.logs', { service: 'web' }], ['env.up', { settings: { enabled: true } }]]) {
    refused(await s.call(method, { ...out, ...extra }), 'PATH_DENIED')
  }
  assert.deepEqual(calls(), [])
})

test('a filesystem ENOENT is a TOOL_ERROR, not a missing tool; only a failed spawn is', { skip }, async (t) => {
  const s = await setup(t)
  const fsError = Object.assign(new Error("ENOENT: no such file or directory, open '/data/stacks/a.log'"), { code: 'ENOENT', syscall: 'open', path: '/data/stacks/a.log' })
  s.ctx.machine = { ...s.ctx.machine, stacks: { ...s.ctx.machine.stacks, log: () => Promise.reject(fsError) } }
  const res = await s.call('stack.log', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, fileId: 0, offset: 0 })
  refused(res, 'TOOL_ERROR')
  assert.equal(res.error.details?.reason, undefined)
  assert.match(res.error.message, /ENOENT: no such file/)
})

test('stack.sh is refused when its real path leaves the worktree; the outside script never runs', { skip }, async (t) => {
  const s = await setup(t)
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-outside-')))
  t.after(() => removeDir(outside))
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

test("stack.up: a second up while one is starting is refused; a run that exits leaves a later run's pid file alone", { skip }, async (t) => {
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

test("a run's events reach only the connection that asked for it", { skip }, async (t) => {
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

test('stack.down and stack.destroy are refused while an up is starting, so the start cannot bring containers up after them', { skip }, async (t) => {
  const s = await setup(t, { stackBody: 'if [ "$1" = up ]; then sleep 30; fi' })
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  // Hold each up inside its start window (marked starting, no pid yet) until the stop has been refused.
  let entered, release
  s.ctx.machine = {
    ...s.ctx.machine,
    stacks: createStackService({
      stateDir: join(s.data, 'stacks'),
      beforeStart: () => {
        entered()
        return new Promise((r) => (release = r))
      }
    })
  }
  for (const method of ['stack.down', 'stack.destroy']) {
    resetCalls()
    const inWindow = new Promise((r) => (entered = r))
    const upping = s.call('stack.up', { ...ref, starter: false })
    await inWindow
    const stop = await s.call(method, ref)
    refused(stop, 'TOOL_ERROR')
    assert.match(stop.error.message, /is starting/)
    // Neither stack.sh ran: the up is still held before its spawn, and the stop never started.
    assert.deepEqual(calls(), [])
    release()
    const up = await upping
    assert.equal(up.ok, true, JSON.stringify(up))
    // Once started, down stops it.
    assert.equal((await s.call('stack.down', ref)).result, 0)
  }
})

test('worktree.teardownPlan (plugins E1): the dev stack once it has run and the VM the branch has; none for the main checkout', { skip }, async (t) => {
  const s = await setup(t)
  const worktreeId = s.worktreeAt(s.feature).id
  const plan = async (op = 'remove') => (await s.call('worktree.teardownPlan', { projectId: s.projectId, worktreeId, op })).result.items
  assert.deepEqual(await plan(), [])
  mkdirSync(join(s.feature, '.trek', 'stack'), { recursive: true })
  assert.equal((await s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })).result.code, 0)
  const profile = deriveProfileName(s.a, 'feature-x')
  const items = [
    { id: 'stack:destroy', label: 'Tear down the dev stack “trek-a-feature-x” (drops its databases)', checked: true },
    { id: 'env:destroy', label: `Stop and delete this worktree's Colima VM “${profile}”`, checked: true }
  ]
  for (const op of ['remove', 'promote', 'move']) assert.deepEqual(await plan(op), items, op)
  // Running (plugins E1): the VM colima lists as running, the stack once a stack.sh up is going.
  writeFileSync(join(stubDir, 'vms'), `${JSON.stringify({ name: profile, status: 'Running' })}\n`)
  t.after(() => rmSync(join(stubDir, 'vms'), { force: true }))
  assert.deepEqual((await plan('move')).map((i) => [i.id, i.running]), [['stack:destroy', undefined], ['env:destroy', true]])
  refused(await s.call('worktree.teardownPlan', { projectId: s.projectId, worktreeId, op: 'delete' }), 'BAD_REQUEST')
  const main = s.repo().worktrees.find((w) => w.isMain)
  refused(await s.call('worktree.teardownPlan', { projectId: s.projectId, worktreeId: main.id, op: 'remove' }), 'BAD_REQUEST')
  refused(await s.call('worktree.teardownPlan', { projectId: s.projectId, worktreeId: 'nope', op: 'remove' }), 'NOT_FOUND')
})

test('worktree.teardownPlan: a branch the environments registry has no VM for runs no colima', { skip }, async (t) => {
  const s = await setup(t)
  const worktreeId = s.worktreeAt(s.feature).id
  resetCalls()
  assert.deepEqual((await s.call('worktree.teardownPlan', { projectId: s.projectId, worktreeId, op: 'remove' })).result.items, [])
  assert.deepEqual(calls().filter((c) => c.startsWith('colima|')), [])
})

test('worktree.remove {teardown} (plugins E1): the chosen items, the stack then the VM, while the worktree is there; then git removes it', { skip }, async (t) => {
  const s = await setup(t)
  writeFileSync(join(s.a, '.git', 'info', 'exclude'), '.trek/\n')
  const worktreeId = s.worktreeAt(s.feature).id
  mkdirSync(join(s.feature, '.trek', 'stack'), { recursive: true })
  await s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })
  resetCalls()
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId, teardown: ['stack:destroy', 'env:destroy'] })
  assert.equal(res.ok, true, JSON.stringify(res))
  const steps = calls()
    .map((c) => c.split('|'))
    .filter(([tool, , args]) => (tool === 'stack' && args === 'destroy') || (tool === 'colima' && args.startsWith('delete ')))
  assert.deepEqual(steps.map(([tool, cwd]) => [tool, tool === 'stack' ? cwd : '']), [['stack', s.feature], ['colima', '']])
  assert.equal(existsSync(s.feature), false)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(s.registryFile, 'utf8'))), [])
})

test('worktree.remove {teardown}: a dirty worktree is refused first; a failing item stops it with the worktree kept; an unknown id is refused; no teardown tears nothing down', { skip }, async (t) => {
  const s = await setup(t, { stackBody: 'if [ "$1" = destroy ]; then exit 4; fi' })
  writeFileSync(join(s.a, '.git', 'info', 'exclude'), '.trek/\n')
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  mkdirSync(join(s.feature, '.trek', 'stack'), { recursive: true })
  await s.call('env.up', { ...ref, settings: { enabled: true, networkAddress: false } })
  const destroyed = () => calls().filter((c) => c.endsWith('|destroy') || c.includes('|delete '))
  resetCalls()
  writeFileSync(join(s.feature, 'scratch.txt'), 'x\n')
  refused(await s.call('worktree.remove', { ...ref, teardown: ['stack:destroy', 'env:destroy'] }), 'GIT_ERROR', 'dirty')
  assert.deepEqual(destroyed(), [], 'nothing torn down for a refused removal')
  const failed = await s.call('worktree.remove', { ...ref, force: true, teardown: ['stack:destroy', 'env:destroy'] })
  refused(failed, 'TOOL_ERROR', 'teardown')
  assert.match(failed.error.message, /^Couldn't tear down the dev stack “trek-a-feature-x” \(drops its databases\): stack\.sh destroy exited with code 4/)
  assert.deepEqual(destroyed().map((c) => c.split('|')[0]), ['stack'], 'the VM was not deleted')
  assert.ok(existsSync(s.feature))
  refused(await s.call('worktree.remove', { ...ref, force: true, teardown: ['ghost:x'] }), 'BAD_REQUEST')
  refused(await s.call('worktree.remove', { ...ref, force: true, teardown: 'stack:destroy' }), 'BAD_REQUEST')
  resetCalls()
  assert.equal((await s.call('worktree.remove', { ...ref, force: true })).ok, true)
  assert.deepEqual(destroyed(), [], 'no teardown field: nothing torn down')
})

test('worktree.remove (plugins E1): a worktree being torn down is CONFLICT with or without teardown; the path is blocked from before the teardown to after the removal; a plugin now off is skipped', { skip }, async (t) => {
  const s = await setup(t)
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  // A plugin participant whose teardown waits until released, and records whether the path was blocked then.
  const log = []
  let release
  const gate = new Promise((r) => (release = r))
  let started
  const teardownStarted = new Promise((r) => (started = r))
  const blocked = new Set()
  const lifecycle = {
    plan: async () => [{ id: 'vm', label: 'Stop the VM', checked: true }],
    teardown: async (_ctx, worktree, op, ids) => {
      log.push([op, ids, blocked.has(worktree.path)])
      started()
      await gate
    }
  }
  const ctx = {
    ...s.ctx,
    sessions: {
      ...s.ctx.sessions,
      blockPath: (path) => {
        blocked.add(path)
        return () => blocked.delete(path)
      }
    },
    plugins: { lifecycles: () => [{ id: 'probe', lifecycle }], inactiveLifecycles: () => ['gone'] }
  }
  const call = (method, params) => dispatchV2(method, params, ctx)
  const removing = call('worktree.remove', { ...ref, force: true, teardown: ['probe:vm', 'gone:x'] })
  await teardownStarted
  assert.deepEqual(log, [['remove', ['vm'], true]])
  refused(await call('worktree.remove', { ...ref, force: true }), 'CONFLICT')
  refused(await call('worktree.remove', { ...ref, force: true, teardown: [] }), 'CONFLICT')
  release()
  const res = await removing
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(existsSync(s.feature), false)
  assert.deepEqual([...blocked], [], 'unblocked once removed')
})

test('worktree.remove {teardown}: git refusing changes that appeared during the teardown carries the reason and what was torn down', { skip }, async (t) => {
  const s = await setup(t)
  writeFileSync(join(s.a, '.git', 'info', 'exclude'), '.trek/\n')
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  const lifecycle = {
    plan: async () => [{ id: 'vm', label: 'Stop the VM', checked: true }],
    teardown: async () => writeFileSync(join(s.feature, 'appeared.txt'), 'new\n')
  }
  const res = await dispatchV2('worktree.remove', { ...ref, teardown: ['probe:vm'] }, { ...s.ctx, plugins: { lifecycles: () => [{ id: 'probe', lifecycle }], inactiveLifecycles: () => [] } })
  refused(res, 'GIT_ERROR', 'dirty')
  assert.deepEqual(res.error.details, { reason: 'dirty', tornDown: ['Stop the VM'] })
  assert.equal(existsSync(s.feature), true)
})

test('worktree.remove {teardown}: the project write failing after the removal carries what was torn down', { skip }, async (t) => {
  const s = await setup(t)
  writeFileSync(join(s.a, '.git', 'info', 'exclude'), '.trek/\n')
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  let tore = false
  const lifecycle = {
    plan: async () => [{ id: 'vm', label: 'Stop the VM', checked: true }],
    teardown: async () => void (tore = true)
  }
  // The handler's own write of the project, once the teardown has run, fails.
  const projects = Object.create(s.ctx.projects)
  projects.apply = (...args) => {
    if (tore) throw new Error('disk full')
    return s.ctx.projects.apply(...args)
  }
  const res = await dispatchV2('worktree.remove', { ...ref, teardown: ['probe:vm'] }, { ...s.ctx, projects, plugins: { lifecycles: () => [{ id: 'probe', lifecycle }], inactiveLifecycles: () => [] } })
  assert.equal(res.ok, false)
  assert.match(res.error.message, /disk full/)
  assert.deepEqual(res.error.details, { tornDown: ['Stop the VM'] })
})

test('repo.remove (plugins E1): refused while a VM of one of its worktrees runs, with the reason; allowed once it is stopped', { skip }, async (t) => {
  const s = await setup(t)
  s.ctx.sessions.forgetRepo = () => {}
  s.ctx.sessions.forgetGlobal = () => {}
  const b = join(s.dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', '-b', 'main', b], { env: gitEnv })
  git(b, 'commit', '--allow-empty', '-q', '-m', 'init')
  s.store.addRepo(b, { id: 'b' })
  assert.equal((await s.call('repo.add', { projectId: s.projectId, path: b })).ok, true)
  await s.call('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true, networkAddress: false } })
  const profile = deriveProfileName(s.a, 'feature-x')
  writeFileSync(join(stubDir, 'vms'), `${JSON.stringify({ name: profile, status: 'Running' })}\n`)
  t.after(() => rmSync(join(stubDir, 'vms'), { force: true }))
  const res = await s.call('repo.remove', { projectId: s.projectId, repoId: s.repoId })
  refused(res, 'BAD_REQUEST')
  assert.equal(res.error.message, 'It has a running environment. Stop it in the Env tab first.')
  writeFileSync(join(stubDir, 'vms'), `${JSON.stringify({ name: profile, status: 'Stopped' })}\n`)
  assert.equal((await s.call('repo.remove', { projectId: s.projectId, repoId: s.repoId })).ok, true)
})

test('repo.remove (plugins E1): a repository the environments registry has no VM for runs no colima', { skip }, async (t) => {
  const s = await setup(t)
  s.ctx.sessions.forgetRepo = () => {}
  s.ctx.sessions.forgetGlobal = () => {}
  // A second repository: the project's last one can't leave.
  const b = join(s.dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', '-b', 'main', b], { env: gitEnv })
  git(b, 'commit', '--allow-empty', '-q', '-m', 'init')
  s.store.addRepo(b, { id: 'b' })
  assert.equal((await s.call('repo.add', { projectId: s.projectId, path: b })).ok, true)
  resetCalls()
  const res = await s.call('repo.remove', { projectId: s.projectId, repoId: s.repoId })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(calls().filter((c) => c.startsWith('colima|')), [])
})

test("stack.destroy and env.destroy (plugins E1) are CONFLICT while the server tears the worktree down; the server's own teardown still runs them", { skip }, async (t) => {
  const s = await setup(t)
  writeFileSync(join(s.a, '.git', 'info', 'exclude'), '.trek/\n')
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  mkdirSync(join(s.feature, '.trek', 'stack'), { recursive: true })
  assert.equal((await s.call('env.up', { ...ref, settings: { enabled: true, networkAddress: false } })).result.code, 0)
  const profile = deriveProfileName(s.a, 'feature-x')
  resetCalls()
  await holdWorktree(s.feature, 'removing it', async () => {
    refused(await s.call('stack.destroy', ref), 'CONFLICT')
    refused(await s.call('env.destroy', { profile }), 'CONFLICT')
  })
  assert.deepEqual(calls().filter((c) => c.startsWith('colima|') || c.startsWith('stack|')), [], 'neither ran')
  // Free again: the client's own call goes through.
  assert.equal((await s.call('stack.destroy', ref)).result, 0)
  // The server's teardown calls the machine directly, under its own hold.
  const res = await s.call('worktree.remove', { ...ref, teardown: ['stack:destroy', 'env:destroy'] })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.ok(calls().some((c) => c.startsWith('colima|') && c.includes(`delete `)), 'the VM was deleted by the teardown')
})

/** A plugin participant (plugins E1) that records its teardowns. */
function probeLifecycle(log) {
  return {
    plan: async () => [{ id: 'vm', label: 'Stop the VM', checked: true }],
    teardown: async (_ctx, _worktree, op, ids) => void log.push([op, ids])
  }
}

test('worktree.remove {teardown}: a VM whose record outlived it (colima has none, so its delete fails) still lets the removal go on', { skip }, async (t) => {
  const s = await setup(t)
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  await s.call('env.up', { ...ref, settings: { enabled: true, networkAddress: false } })
  writeFileSync(join(stubDir, 'delete-fails-unlisted'), '')
  t.after(() => rmSync(join(stubDir, 'delete-fails-unlisted'), { force: true }))
  const plan = (await s.call('worktree.teardownPlan', { ...ref, op: 'remove' })).result.items
  assert.deepEqual(plan.map((i) => i.id), ['env:destroy'], 'the record is planned though colima lists no VM')
  resetCalls()
  const res = await s.call('worktree.remove', { ...ref, teardown: ['env:destroy'] })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(calls().filter((c) => c.includes('|delete ')).length, 1, 'colima delete ran (and failed)')
  assert.equal(existsSync(s.feature), false)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(s.registryFile, 'utf8'))), [])
})

test('worktree.remove {teardown}: a VM colima still lists after a failed delete fails the removal, the worktree kept', { skip }, async (t) => {
  const s = await setup(t)
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  await s.call('env.up', { ...ref, settings: { enabled: true, networkAddress: false } })
  const profile = deriveProfileName(s.a, 'feature-x')
  // Opt in: every delete fails, and colima still lists the VM after it.
  writeFileSync(join(stubDir, 'vms'), `${JSON.stringify({ name: profile, status: 'Running' })}\n`)
  writeFileSync(join(stubDir, 'delete-fails'), '')
  t.after(() => {
    for (const f of ['vms', 'delete-fails']) rmSync(join(stubDir, f), { force: true })
  })
  const listed = (await s.call('env.list', { projectId: s.projectId, repoId: s.repoId })).result
  assert.deepEqual(listed.map((e) => [e.profile, e.vmState]), [[profile, 'running']])
  const res = await s.call('worktree.remove', { ...ref, teardown: ['env:destroy'] })
  refused(res, 'TOOL_ERROR', 'teardown')
  assert.match(res.error.message, /deleting the VM exited with code 1/)
  assert.ok(existsSync(s.feature))
})

test('worktree.remove: a load that lands before the block is IN_USE, and nothing is torn down', { skip }, async (t) => {
  const s = await setup(t)
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  const log = []
  const ctx = {
    ...s.ctx,
    sessions: {
      ...s.ctx.sessions,
      // The load lands just as the block is taken: after the first check, before the teardown.
      blockPath: () => {
        s.projects.apply(s.projectId, (d) => {
          d.repositories[0].worktrees.find((w) => w.id === ref.worktreeId).loaded = true
        })
        return () => {}
      }
    },
    plugins: { lifecycles: () => [{ id: 'probe', lifecycle: probeLifecycle(log) }] }
  }
  refused(await dispatchV2('worktree.remove', { ...ref, force: true, teardown: ['probe:vm'] }, ctx), 'IN_USE')
  assert.deepEqual(log, [])
  assert.ok(existsSync(s.feature))
})

test('worktree.remove {teardown}: a worktree whose status git cannot read is refused (GIT_ERROR) before anything is torn down', { skip }, async (t) => {
  const s = await setup(t)
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  const log = []
  const ctx = { ...s.ctx, plugins: { lifecycles: () => [{ id: 'probe', lifecycle: probeLifecycle(log) }] } }
  writeFileSync(join(s.feature, '.git'), `gitdir: ${join(s.dir, 'nowhere')}\n`)
  const res = await dispatchV2('worktree.remove', { ...ref, teardown: ['probe:vm'] }, ctx)
  refused(res, 'GIT_ERROR')
  assert.match(res.error.message, /nothing was torn down/)
  assert.deepEqual(log, [])
})

test('worktree.remove {teardown}: a missing row\'s VM is deleted, git is not run, the row is dropped', { skip }, async (t) => {
  const s = await setup(t)
  const ref = { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id }
  await s.call('env.up', { ...ref, settings: { enabled: true, networkAddress: false } })
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees.find((w) => w.id === ref.worktreeId).missing = true
  })
  resetCalls()
  const res = await s.call('worktree.remove', { ...ref, teardown: ['env:destroy'] })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(calls().filter((c) => c.includes('|delete ')).length, 1, 'the VM was deleted')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(s.registryFile, 'utf8'))), [])
  // Git was not run: the folder (still on disk here) and git's record of it stay.
  assert.ok(existsSync(s.feature))
  assert.ok(git(s.a, 'worktree', 'list', '--porcelain').includes(`worktree ${s.feature}\n`))
  assert.equal(s.worktreeAt(s.feature), undefined, 'the row is dropped')
})

test("repo.remove (plugins E1): a running VM whose worktree folder is gone still refuses; a twb- leftover with no record doesn't; the last repository's own refusal comes first", { skip }, async (t) => {
  const s = await setup(t)
  s.ctx.sessions.forgetRepo = () => {}
  s.ctx.sessions.forgetGlobal = () => {}
  await s.call('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true, networkAddress: false } })
  const profile = deriveProfileName(s.a, 'feature-x')
  writeFileSync(join(stubDir, 'vms'), `${JSON.stringify({ name: profile, status: 'Running' })}\n`)
  t.after(() => rmSync(join(stubDir, 'vms'), { force: true }))
  const last = await s.call('repo.remove', { projectId: s.projectId, repoId: s.repoId })
  refused(last, 'BAD_REQUEST')
  assert.equal(last.error.message, 'a project needs at least one repository')
  const b = join(s.dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', '-b', 'main', b], { env: gitEnv })
  git(b, 'commit', '--allow-empty', '-q', '-m', 'init')
  s.store.addRepo(b, { id: 'b' })
  assert.equal((await s.call('repo.add', { projectId: s.projectId, path: b })).ok, true)
  rmSync(s.feature, { recursive: true, force: true })
  const orphaned = (await s.call('env.list', { projectId: s.projectId, repoId: s.repoId })).result
  assert.deepEqual(orphaned.map((e) => [e.profile, e.vmState, e.orphaned]), [[profile, 'running', true]])
  const res = await s.call('repo.remove', { projectId: s.projectId, repoId: s.repoId })
  refused(res, 'BAD_REQUEST')
  assert.equal(res.error.message, 'It has a running environment. Stop it in the Env tab first.')
  // Only a leftover no registry names (another repository's, or a crash's) runs now.
  writeFileSync(join(stubDir, 'vms'), `${JSON.stringify({ name: profile, status: 'Stopped' })}\n${JSON.stringify({ name: 'twb-leftover-000000', status: 'Running' })}\n`)
  assert.equal((await s.call('repo.remove', { projectId: s.projectId, repoId: s.repoId })).ok, true)
})
