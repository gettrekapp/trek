// scripts/colimaPlugin.test.mjs — the Colima environments plugin (plugins E2): its env.* methods with
// core's checks, its env.log to the asking connection, its worktree lifecycle (env:destroy and the
// repository check), against real git in a temp dir and the stub docker and colima of
// scripts/machineHarness.mjs (nothing here runs a real one).
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holdWorktree } from '../server/src/teardown/teardown.ts'
import { colimaLifecycle } from '../plugins/colima/server/lifecycle.ts'
import { deriveProfileName, envListProblem } from '../plugins/colima/shared/environments.ts'
import { ClientError } from '../src/shared/client/connection.ts'
import { removeDir } from './testPlatform.mjs'
import { calls, git, originalPath, refused, resetCalls, setup, skip, stubDir } from './machineHarness.mjs'

test('the plugin is a teardown participant under the id env (plugins E2), on by default, with the env capability', { skip }, async (t) => {
  const s = await setup(t)
  assert.deepEqual(s.ctx.plugins.lifecycles(s.projectId).map((l) => l.id), ['env'])
  assert.deepEqual(s.ctx.plugins.presence(), [{ id: 'env', version: '1.0.0', defaultEnabled: true }])
  assert.deepEqual(s.ctx.plugins.legacyCapabilities(), ['env'])
})

test("env.up (plugins E2): the VM under the repository's profileKey (its repo setting), colima in the plugin's data directory, the registry there, env.log to the asking connection only", { skip }, async (t) => {
  const s = await setup(t)
  const other = s.connection()
  assert.equal((await s.call('repo.update', { projectId: s.projectId, repoId: s.repoId, environments: { enabled: true, profileKey: '/old/spelling/a' } })).ok, true)
  const profile = deriveProfileName('/old/spelling/a', 'feature-x')
  const res = await s.call('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true, networkAddress: false }, envVars: { FOO: 'bar' } })
  assert.deepEqual(res.result, { code: 0, address: undefined })
  assert.deepEqual(calls().filter((c) => !c.includes('|list --json|')), [
    `colima|${s.pluginDir}|start ${profile} --cpu 2 --memory 4 --disk 20|FOO=`,
    `docker|${s.feature}|--context colima-${profile} compose -f docker-compose.yml up -d|FOO=bar`
  ])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(s.registryFile, 'utf8'))), [profile])
  assert.equal(statSync(s.registryFile).mode & 0o777, 0o600)
  assert.equal(existsSync(join(s.data, 'environments.json')), false, 'not in the old place')
  assert.deepEqual(s.events.filter(([, e]) => e.step).map(([, e]) => e.step), ['vm', 'compose', 'ready'])
  assert.equal(s.events.every(([event, e]) => event === 'env.log' && e.profile === profile), true)
  assert.deepEqual(other.events, [])
})

test('the plugin checks paths as core did (plugins E2): outside the allowlist PATH_DENIED, a missing row BAD_REQUEST, an unknown one NOT_FOUND, a detached one BAD_REQUEST', { skip }, async (t) => {
  const s = await setup(t)
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-colima-outside-')))
  t.after(() => removeDir(outside))
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees.push({ id: 'out', name: 'out', path: outside, branch: 'feature-x', isMain: false, loaded: false, sessions: [] })
    d.repositories[0].worktrees.push({ id: 'gone', name: 'gone', path: join(s.dir, 'gone'), branch: 'gone', isMain: false, missing: true, loaded: false, sessions: [] })
  })
  for (const [method, extra] of [['env.ps', {}], ['env.composeFiles', {}], ['env.logs', { service: 'web' }], ['env.up', { settings: { enabled: true } }]]) {
    refused(await s.call(method, { projectId: s.projectId, worktreeId: 'out', ...extra }), 'PATH_DENIED')
    refused(await s.call(method, { projectId: s.projectId, worktreeId: 'gone', ...extra }), 'BAD_REQUEST')
    refused(await s.call(method, { projectId: s.projectId, worktreeId: 'nope', ...extra }), 'NOT_FOUND')
  }
  refused(await s.call('env.list', { projectId: s.projectId, repoId: 'nope' }), 'NOT_FOUND')
  refused(await s.call('env.list', { projectId: 42, repoId: s.repoId }), 'BAD_REQUEST')
  git(s.feature, 'checkout', '-q', '--detach')
  refused(await s.call('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true } }), 'BAD_REQUEST')
  assert.deepEqual(calls().filter((c) => c.startsWith('colima|') || c.startsWith('docker|')), [])
})

test("env.destroy (plugins E2) is CONFLICT while the server holds a worktree of that VM's branch, and runs once it is free", { skip }, async (t) => {
  const s = await setup(t)
  const profile = deriveProfileName(s.a, 'feature-x')
  await holdWorktree(s.feature, 'removing it', async () => {
    const res = await s.call('env.destroy', { profile })
    refused(res, 'CONFLICT')
    assert.equal(res.error.message, 'this worktree is busy: removing it; try again once it is done')
  })
  assert.equal((await s.call('env.destroy', { profile })).result, 0)
  assert.deepEqual(calls(), [`colima|${s.pluginDir}|delete ${profile} --force|FOO=`])
})

/** The lifecycle over a stand-in environment service: the registry's answers and colima's list. */
function lifecycleWith({ known = [], repos = [], vms = [], destroy = async () => 0, enabled = true } = {}) {
  const asked = { list: 0, destroyed: [], events: [] }
  const host = { repoSettings: () => ({}), emitTo: (caller, event, payload) => asked.events.push([caller, event, payload]), isEnabled: () => enabled }
  const env = {
    known: async (profile) => known.includes(profile),
    knownRepo: async (key) => repos.includes(key),
    list: async () => (asked.list++, vms),
    destroy: async (profile, onLog) => {
      asked.destroyed.push(profile)
      onLog({ profile, data: 'gone\n', done: true })
      return destroy()
    }
  }
  return { lifecycle: colimaLifecycle(host, env), asked, env }
}
const ctx = { projectId: 'p1', caller: 'c1' }
const feat = { id: 'w2', repoId: 'r1', repoPath: '/r/app', path: '/r/app-feat', branch: 'feat', present: true }
const featProfile = deriveProfileName('/r/app', 'feat')

test("the lifecycle's plan (plugins E2): the branch's VM, running or not; none without a registry entry (no colima list) or a branch", async () => {
  const running = lifecycleWith({ known: [featProfile], vms: [{ profile: featProfile, vmState: 'running', worktreePath: feat.path }] })
  assert.deepEqual(await running.lifecycle.plan(ctx, feat, 'remove'), [{ id: 'destroy', label: `Stop and delete this worktree's Colima VM “${featProfile}”`, checked: true, running: true }])
  for (const vmState of ['stopped', 'missing']) {
    const { lifecycle } = lifecycleWith({ known: [featProfile], vms: [{ profile: featProfile, vmState, worktreePath: feat.path }] })
    assert.deepEqual((await lifecycle.plan(ctx, feat, 'move')).map((i) => [i.id, i.running]), [['destroy', undefined]], vmState)
  }
  const unknown = lifecycleWith({ vms: [{ profile: featProfile, vmState: 'running', worktreePath: feat.path }] })
  assert.deepEqual(await unknown.lifecycle.plan(ctx, feat, 'remove'), [])
  assert.equal(unknown.asked.list, 0, 'no colima list for a branch the registry has no VM for')
  assert.deepEqual(await running.lifecycle.plan(ctx, { ...feat, branch: null }, 'remove'), [])
})

test("the lifecycle's teardown deletes the VM, its log to the asking connection; a failed delete stops it only while colima still lists the VM", async () => {
  const ok = lifecycleWith({ known: [featProfile] })
  await ok.lifecycle.teardown(ctx, feat, 'remove', ['destroy'])
  assert.deepEqual(ok.asked.destroyed, [featProfile])
  assert.deepEqual(ok.asked.events, [['c1', 'env.log', { profile: featProfile, data: 'gone\n', done: true }]])
  const gone = lifecycleWith({ destroy: async () => 1, vms: [{ profile: featProfile, vmState: 'missing', worktreePath: feat.path }] })
  await gone.lifecycle.teardown(ctx, feat, 'remove', ['destroy'])
  const left = lifecycleWith({ destroy: async () => 1, vms: [{ profile: featProfile, vmState: 'stopped', worktreePath: feat.path }] })
  await assert.rejects(left.lifecycle.teardown(ctx, feat, 'remove', ['destroy']), /deleting the VM exited with code 1/)
})

test("the lifecycle's repository check asks the registry first: no VM of the repository, no colima list; a running one refuses; a leftover no record names doesn't", async () => {
  const repo = { id: 'r1', path: '/r/app', name: 'app' }
  const none = lifecycleWith({ vms: [{ profile: 'twb-x-000000', vmState: 'running', worktreePath: feat.path }] })
  assert.equal(await none.lifecycle.beforeRepoRemove(ctx, repo), null)
  assert.equal(none.asked.list, 0)
  const running = lifecycleWith({ repos: ['/r/app'], vms: [{ profile: 'twb-x-000000', vmState: 'running', worktreePath: feat.path }] })
  assert.equal(await running.lifecycle.beforeRepoRemove(ctx, repo), 'It has a running environment. Stop it in the Env tab first.')
  const leftover = lifecycleWith({ repos: ['/r/app'], vms: [{ profile: 'twb-y-000000', vmState: 'running', worktreePath: '' }] })
  assert.equal(await leftover.lifecycle.beforeRepoRemove(ctx, repo), null)
})

test("the lifecycle's repository check where the plugin is off for the project (plugins E3): a running VM still refuses, saying how to reach it; a stopped one doesn't", async () => {
  const repo = { id: 'r1', path: '/r/app', name: 'app' }
  const running = lifecycleWith({ enabled: false, repos: ['/r/app'], vms: [{ profile: 'twb-x-000000', vmState: 'running', worktreePath: feat.path }] })
  assert.equal(
    await running.lifecycle.beforeRepoRemove(ctx, repo),
    'It has a running Colima VM. Turn Colima environments on for this project (Settings → Plugins), then stop it in the Env tab.'
  )
  const stopped = lifecycleWith({ enabled: false, repos: ['/r/app'], vms: [{ profile: 'twb-x-000000', vmState: 'stopped', worktreePath: feat.path }] })
  assert.equal(await stopped.lifecycle.beforeRepoRemove(ctx, repo), null)
})

test("the lifecycle takes only a colima that isn't installed as no VMs; any other failure to list is the plan's and the repository check's own", async () => {
  const failing = (err) => {
    const made = lifecycleWith({ known: [featProfile], repos: ['/r/app'] })
    // The stand-in's list, failing as the host or the file system would.
    return colimaLifecycle({ repoSettings: () => ({}), emitTo: () => {}, isEnabled: () => true }, { ...made.env, list: async () => Promise.reject(err) })
  }
  const notInstalled = Object.assign(new Error('colima is not installed on the server'), { code: 'ENOENT' })
  const fileGone = Object.assign(new Error("ENOENT: no such file or directory, open '/x'"), { code: 'ENOENT', syscall: 'open', path: '/x' })
  const none = failing(notInstalled)
  assert.deepEqual(await none.plan(ctx, feat, 'remove'), [])
  assert.equal(await none.beforeRepoRemove(ctx, { id: 'r1', path: '/r/app', name: 'app' }), null)
  const broken = failing(fileGone)
  await assert.rejects(broken.plan(ctx, feat, 'remove'), /no such file/)
  await assert.rejects(broken.beforeRepoRemove(ctx, { id: 'r1', path: '/r/app', name: 'app' }), /no such file/)
})

test('env.up refuses where the plugin is off for the project; the other methods still answer, and a VM made before is still torn down with its worktree (plugins E3)', { skip }, async (t) => {
  const s = await setup(t)
  const worktreeId = s.worktreeAt(s.feature).id
  assert.equal((await s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })).result.code, 0)
  const profile = deriveProfileName(s.a, 'feature-x')
  s.projects.apply(s.projectId, (d) => {
    d.settings.plugins = { ...d.settings.plugins, env: { enabled: false } }
  })
  resetCalls()
  const res = await s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })
  refused(res, 'BAD_REQUEST')
  assert.equal(res.error.message, 'Colima environments are turned off for this project')
  assert.deepEqual(calls(), [], 'nothing ran')
  // The VM made before can still be seen, stopped and destroyed.
  assert.deepEqual((await s.call('env.list', { projectId: s.projectId, repoId: s.repoId })).result.map((e) => e.profile), [profile])
  assert.equal((await s.call('env.ps', { projectId: s.projectId, worktreeId })).ok, true)
  assert.equal((await s.call('env.stop', { profile })).result, 0)
  assert.equal((await s.call('env.destroy', { profile })).result, 0)
  // Its lifecycle still takes part there (plugins E3): a remove's plan offers the VM's teardown.
  assert.equal((await s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })).error?.code, 'BAD_REQUEST')
  s.projects.apply(s.projectId, (d) => {
    d.settings.plugins = { ...d.settings.plugins, env: { enabled: true } }
  })
  assert.equal((await s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })).result.code, 0)
  s.projects.apply(s.projectId, (d) => {
    d.settings.plugins = { ...d.settings.plugins, env: { enabled: false } }
  })
  const offPlan = await s.call('worktree.teardownPlan', { projectId: s.projectId, worktreeId, op: 'remove' })
  assert.ok(offPlan.result.items.some((i) => i.id === 'env:destroy'), JSON.stringify(offPlan))
  // Still off: the repository is kept while the VM runs, the reason saying how to reach it.
  const b = join(s.dir, 'repos', 'b')
  mkdirSync(b, { recursive: true })
  git(b, 'init', '-q', '-b', 'main')
  git(b, 'commit', '--allow-empty', '-q', '-m', 'init')
  s.store.addRepo(b, { id: 'b' })
  assert.equal((await s.call('repo.add', { projectId: s.projectId, path: b })).ok, true)
  writeFileSync(join(stubDir, 'vms'), `${JSON.stringify({ name: profile, status: 'Running' })}\n`)
  t.after(() => rmSync(join(stubDir, 'vms'), { force: true }))
  const kept = await s.call('repo.remove', { projectId: s.projectId, repoId: s.repoId })
  refused(kept, 'BAD_REQUEST')
  assert.equal(kept.error.message, 'It has a running Colima VM. Turn Colima environments on for this project (Settings → Plugins), then stop it in the Env tab.')
  // And a remove with env:destroy deletes the VM before git removes the worktree.
  writeFileSync(join(s.a, '.git', 'info', 'exclude'), '.trek/\n')
  resetCalls()
  const removed = await s.call('worktree.remove', { projectId: s.projectId, worktreeId, teardown: ['env:destroy'] })
  assert.equal(removed.ok, true, JSON.stringify(removed))
  assert.ok(calls().some((c) => c.startsWith('colima|') && c.includes(`|delete ${profile} --force|`)), calls().join('\n'))
  assert.equal(existsSync(s.feature), false)
  // An unknown worktree is still NOT_FOUND first.
  refused(await s.call('env.up', { projectId: s.projectId, worktreeId: 'nope', settings: { enabled: true } }), 'NOT_FOUND')
})

test("env.up starts the branch's VM under the repository's envRepoKey, with the checked settings and variables", { skip }, async (t) => {
  const s = await setup(t)
  // An imported repository keeps the path its VMs were named after (an older client's write: the mirror carries it to the plugin's setting).
  assert.equal((await s.call('repo.update', { projectId: s.projectId, repoId: s.repoId, environments: { enabled: true, profileKey: '/old/spelling/a' } })).ok, true)
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
    `colima|${s.pluginDir}|start ${profile} --cpu 3 --memory 6 --disk 20|FOO=`,
    `docker|${s.feature}|--context colima-${profile} compose -f docker-compose.yml up -d|FOO=bar`,
    `colima|${process.cwd()}|list --json|FOO=`
  ])
  const registry = JSON.parse(readFileSync(s.registryFile, 'utf8'))
  assert.deepEqual(Object.keys(registry), [profile])
  assert.deepEqual([registry[profile].repoPath, registry[profile].branch, registry[profile].worktreePath, registry[profile].envVars], ['/old/spelling/a', 'feature-x', s.feature, { FOO: 'bar' }])
  assert.equal(statSync(s.registryFile).mode & 0o777, 0o600)
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

test('env.up refuses settings, compose files and variables that would steer the run, before colima runs', { skip }, async (t) => {
  const s = await setup(t)
  const worktreeId = s.worktreeAt(s.feature).id
  const up = (extra) => s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true }, ...extra })
  for (const composeFile of ['../outside.yml', '/etc/passwd', '-f /etc/x', 'a/../../b.yml', 'ok.yml,../x.yml', 'x\0.yml', '.']) {
    refused(await up({ settings: { enabled: true, composeFile } }), 'BAD_REQUEST')
  }
  for (const settings of [{ enabled: true, cpu: 0 }, { enabled: true, memory: 0.25 }, { enabled: true, memory: Number.NaN }, { enabled: true, memory: '2' }, { enabled: true, memory: 2000 }, { enabled: true, cpu: 1.5 }, { enabled: true, disk: 20.5 }, { enabled: true, disk: '20' }, { enabled: true, rosetta: 'yes' }, { enabled: true, extra: 1 }, 'x', null]) {
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
  t.after(() => removeDir(outside))
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
  assert.equal(existsSync(s.registryFile), false)
  // An ordinary name still passes, and a symlink that stays inside the worktree is fine.
  symlinkSync(join(s.feature, 'docker-compose.yml'), join(s.feature, 'linked.yml'))
  assert.equal((await up({ settings: { enabled: true, networkAddress: false, composeFile: 'linked.yml' }, envVars: { API_URL: 'http://x' } })).result.code, 0)
})

test('env.up takes a fractional memory size, as colima --memory does (GiB)', { skip }, async (t) => {
  const s = await setup(t)
  const worktreeId = s.worktreeAt(s.feature).id
  const profile = deriveProfileName(s.a, 'feature-x')
  const res = await s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, cpu: 2, memory: 1.5, disk: 30, networkAddress: false } })
  assert.equal(res.result.code, 0)
  assert.equal(calls()[0], `colima|${s.pluginDir}|start ${profile} --cpu 2 --memory 1.5 --disk 30|FOO=`)
  assert.equal((await s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, memory: 0.5, networkAddress: false } })).result.code, 0)
})

test("a symlinked default docker-compose.yml (into the main checkout, say) is the repository's: no composeFile, no confinement", { skip }, async (t) => {
  const s = await setup(t)
  const worktreeId = s.worktreeAt(s.feature).id
  const profile = deriveProfileName(s.a, 'feature-x')
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-outside-')))
  t.after(() => removeDir(outside))
  writeFileSync(join(outside, 'docker-compose.yml'), 'services: {}\n')
  unlinkSync(join(s.feature, 'docker-compose.yml'))
  symlinkSync(join(outside, 'docker-compose.yml'), join(s.feature, 'docker-compose.yml'))
  const res = await s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })
  assert.equal(res.result.code, 0, JSON.stringify(res))
  assert.equal(calls()[1], `docker|${s.feature}|--context colima-${profile} compose -f docker-compose.yml up -d|FOO=`)
  // ps and logs without a composeFile read the default file too.
  resetCalls()
  assert.equal((await s.call('env.ps', { projectId: s.projectId, worktreeId })).ok, true)
  assert.equal((await s.call('env.logs', { projectId: s.projectId, worktreeId, service: 'web' })).ok, true)
  assert.deepEqual(calls().map((c) => c.split('|')[2]), [
    `--context colima-${profile} compose -f docker-compose.yml ps --format json`,
    `--context colima-${profile} compose -f docker-compose.yml logs --no-color --tail 300 web`
  ])
  // A client that names it explicitly is still held to the check.
  refused(await s.call('env.ps', { projectId: s.projectId, worktreeId, composeFile: 'docker-compose.yml' }), 'BAD_REQUEST')
})

test('env.destroy deletes the VM and its registry entry; two environments started at once both stay registered', { skip }, async (t) => {
  const s = await setup(t)
  git(s.a, 'worktree', 'add', '-q', '-b', 'feature-y', `${s.a}-feature-y`)
  await s.ctx.poller.refresh(s.a)
  const [x, y] = [s.worktreeAt(s.feature).id, s.worktreeAt(`${s.a}-feature-y`).id]
  const results = await Promise.all([x, y].map((worktreeId) => s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } })))
  assert.deepEqual(results.map((r) => r.result.code), [0, 0])
  const px = deriveProfileName(s.a, 'feature-x')
  const py = deriveProfileName(s.a, 'feature-y')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(s.registryFile, 'utf8'))).sort(), [px, py].sort())
  resetCalls()
  assert.equal((await s.call('env.destroy', { profile: px })).result, 0)
  assert.deepEqual(calls(), [`docker|${s.feature}|--context colima-${px} compose -f docker-compose.yml down -v|FOO=`, `colima|${s.pluginDir}|delete ${px} --force|FOO=`])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(s.registryFile, 'utf8'))), [py])
  assert.equal((await s.call('env.stop', { profile: py })).result, 0)
})

test('the registry: a file that cannot be read is never overwritten; a leftover temp file does not loosen 0600', { skip }, async (t) => {
  const s = await setup(t)
  const registryFile = s.registryFile
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

test('env.destroy skips docker compose for a registry entry outside the allowlist, and still deletes the VM', { skip }, async (t) => {
  const s = await setup(t)
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-machine-outside-')))
  t.after(() => removeDir(outside))
  writeFileSync(join(outside, 'docker-compose.yml'), 'services: {}\n')
  const profile = 'twb-imported-000000'
  writeFileSync(s.registryFile, JSON.stringify({ [profile]: { repoPath: s.a, branch: 'x', worktreePath: outside, createdAt: 'then' } }))
  assert.equal((await s.call('env.destroy', { profile })).result, 0)
  assert.deepEqual(calls(), [`colima|${s.pluginDir}|delete ${profile} --force|FOO=`])
  assert.match(s.events.map(([, e]) => e.data).join(''), /skipping docker compose down/)
  assert.deepEqual(JSON.parse(readFileSync(s.registryFile, 'utf8')), {})
})

test("env.up refuses a worktree outside Colima's home on a path boundary (/x/rep is not /x/repos)", { skip }, async (t) => {
  // A home that is a string prefix of the worktree's path but not one of its directories.
  const s = await setup(t, { home: (dir) => join(dir, 'rep') })
  const res = await s.call('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true } })
  assert.equal(res.result.code, -1)
  assert.match(res.result.error, /outside the home directory/)
  assert.deepEqual(calls(), [])
})

test('env.list: a registry file that cannot be read is a TOOL_ERROR naming it, not a list of orphans', { skip }, async (t) => {
  const s = await setup(t)
  const registryFile = s.registryFile
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

test('env.list and env.up refuse an unknown repository and a missing row before colima runs (the codes the Colima plugin keeps)', { skip }, async (t) => {
  const s = await setup(t)
  resetCalls()
  refused(await s.call('env.list', { projectId: s.projectId, repoId: 'nope' }), 'NOT_FOUND')
  const worktreeId = s.worktreeAt(s.feature).id
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees.find((w) => w.id === worktreeId).missing = true
  })
  refused(await s.call('env.up', { projectId: s.projectId, worktreeId, settings: { enabled: true, networkAddress: false } }), 'BAD_REQUEST')
  assert.deepEqual(calls(), [])
})

test("a Local server reads the other Local profiles' registries (read-only): their VMs are not orphans to delete", { skip }, async (t) => {
  const s = await setup(t)
  const parent = join(s.dir, 'trek-server')
  const own = join(parent, 'local')
  mkdirSync(own, { recursive: true })
  // An upgraded sibling (its plugin's file; its old file is stale and not read), one not upgraded yet (its old file), a torn one.
  mkdirSync(join(parent, 'local-dev', 'plugins', 'env'), { recursive: true })
  const sibling = join(parent, 'local-dev', 'plugins', 'env', 'environments.json')
  const siblingText = JSON.stringify({ 'twb-devvm-000000': { repoPath: '/elsewhere', branch: 'b', worktreePath: '/elsewhere-b', createdAt: 'then' } })
  writeFileSync(sibling, siblingText, { mode: 0o600 })
  writeFileSync(join(parent, 'local-dev', 'environments.json'), JSON.stringify({ 'twb-gonevm-000000': { repoPath: '/elsewhere', branch: 'g', worktreePath: '/elsewhere-g', createdAt: 'then' } }))
  mkdirSync(join(parent, 'local-old'))
  writeFileSync(join(parent, 'local-old', 'environments.json'), JSON.stringify({ 'twb-oldvm-000000': { repoPath: '/elsewhere', branch: 'o', worktreePath: '/elsewhere-o', createdAt: 'then' } }))
  mkdirSync(join(parent, 'local-torn'))
  writeFileSync(join(parent, 'local-torn', 'environments.json'), '{"twb-torn')
  const siblingStat = statSync(sibling)
  const vms = ['twb-devvm-000000', 'twb-oldvm-000000', 'twb-gonevm-000000', 'twb-leftover-000000', 'twb-torn-000000']
  writeFileSync(join(stubDir, 'vms'), vms.map((name) => JSON.stringify({ name, status: 'Running' })).join('\n') + '\n')
  t.after(() => rmSync(join(stubDir, 'vms'), { force: true }))
  const list = async () => (await s.call('env.list', { projectId: s.projectId, repoId: s.repoId })).result.map((e) => [e.profile, e.orphaned])
  const local = s.usePlugin({ dataDir: own, local: true })
  assert.deepEqual(await list(), [['twb-gonevm-000000', true], ['twb-leftover-000000', true], ['twb-torn-000000', true]])
  // Its own registry still works beside them, and the siblings' files are never written.
  assert.equal((await s.call('env.up', { projectId: s.projectId, worktreeId: s.worktreeAt(s.feature).id, settings: { enabled: true, networkAddress: false } })).result.code, 0)
  assert.equal(existsSync(local.registryFile), true)
  assert.equal(readFileSync(sibling, 'utf8'), siblingText)
  assert.equal(statSync(sibling).mtimeMs, siblingStat.mtimeMs)
  // A server that is not Local reads only its own registry: every unknown twb- VM is an orphan.
  s.usePlugin({ dataDir: join(parent, 'local-dev') })
  assert.deepEqual((await list()).filter(([, orphaned]) => orphaned).map(([p]) => p), ['twb-oldvm-000000', 'twb-gonevm-000000', 'twb-leftover-000000', 'twb-torn-000000'])
  mkdirSync(join(s.dir, 'plain'))
  s.usePlugin({ dataDir: join(s.dir, 'plain') })
  assert.deepEqual((await list()).map(([p]) => p), vms)
})
