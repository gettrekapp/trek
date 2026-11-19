// scripts/colimaPlugin.test.mjs — the Colima environments plugin (plugins E2): its env.* methods with
// core's checks, its env.log to the asking connection, its worktree lifecycle (env:destroy and the
// repository check), against real git in a temp dir and the stub docker and colima of
// scripts/machineHarness.mjs (nothing here runs a real one).
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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
function lifecycleWith({ known = [], repos = [], vms = [], destroy = async () => 0 } = {}) {
  const asked = { list: 0, destroyed: [], events: [] }
  const host = { repoSettings: () => ({}), emitTo: (caller, event, payload) => asked.events.push([caller, event, payload]) }
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
  return { lifecycle: colimaLifecycle(host, env), asked }
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
