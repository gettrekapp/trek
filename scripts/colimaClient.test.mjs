// scripts/colimaClient.test.mjs — the Colima plugin's client half (plugins E3): what Start passes to
// env.up (the pending value, through the window's settings writer), the poll's ticks and its list,
// the Run menu's Env entry, the settings it reads and writes, and the old-server fallback's part.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ENV_RECHECK_TICKS, envPollTick } from '../plugins/colima/client/pollTick.ts'
import { composeFileArg, createRunLogFilter, envStartArgs } from '../plugins/colima/client/start.ts'
import { branchVars, envOn, patchedSettings, repoKeyOf, withBranchVars } from '../plugins/colima/client/settings.ts'
import { envPanelEntry } from '../plugins/colima/client/panelEntry.ts'
import { colimaLegacyTeardown } from '../plugins/colima/client/legacyTeardown.ts'
import { refreshEnvironments } from '../plugins/colima/client/poll.ts'
import { useColimaStore } from '../plugins/colima/client/store.ts'
import { deriveProfileName } from '../plugins/colima/shared/environments.ts'
import { v2SettingsOverrides } from '../src/renderer/src/v2/settingsOverrides.ts'
import { createSettingsWriter } from '../src/renderer/src/v2/settingsWriter.ts'
import { projectV2 } from '../src/renderer/src/v2/projector.ts'
import { pluginReposOf } from '../src/renderer/src/plugins/projectView.ts'

/** A repository as host.repos() gives it. */
const repo = (settings = {}, branchSettings = {}, more = {}) => ({ id: 'r', name: 'r', path: '/r', settings, branchSettings, worktrees: [], ...more })
const feat = { id: 'w2', repoId: 'r', path: '/r-feat', branch: 'feat', isMain: false, missing: false }
const fakeHost = (repos, more = {}) => ({ projectId: 'p1', repos: () => repos, isCurrent: () => true, onEvent: () => () => {}, ...more })
const profile = deriveProfileName('/r', 'feat')
const vm = (vmState, more = {}) => ({ profile, repoPath: '/r', branch: 'feat', worktreePath: '/r-feat', vmState, ...more })

test('no answer yet: every tick asks env.check; a passed check lists; a failed one is asked again every ENV_RECHECK_TICKS ticks', () => {
  for (let tick = 1; tick <= 3; tick++) assert.equal(envPollTick(null, tick), 'check')
  for (let tick = 1; tick <= 2 * ENV_RECHECK_TICKS; tick++) assert.equal(envPollTick({ ok: true }, tick), 'list')
  assert.equal(ENV_RECHECK_TICKS, 6)
  const ticks = Array.from({ length: 13 }, (_, i) => envPollTick({ ok: false, error: 'colima not found' }, i + 1))
  assert.deepEqual(ticks.map((t, i) => (t === 'check' ? i + 1 : null)).filter(Boolean), [6, 12])
})

test('envStartArgs: the branch variables parsed, the repository settings with the chosen compose file', () => {
  const r = repo({ enabled: false, cpu: 4 }, { feat: { env: 'A=1\nB=2' } })
  assert.deepEqual(envStartArgs(r, 'feat', 'compose.yml'), { settings: { enabled: false, cpu: 4, composeFile: 'compose.yml' }, envVars: { A: '1', B: '2' } })
  assert.deepEqual(envStartArgs(r, 'other', 'c.yml'), { settings: { enabled: false, cpu: 4, composeFile: 'c.yml' }, envVars: undefined })
  assert.deepEqual(envStartArgs(undefined, 'feat', 'c.yml'), { settings: { enabled: true, composeFile: 'c.yml' }, envVars: undefined })
})

test('envStartArgs sends only the keys env.up takes, each of its type: not a profileKey, nor what another client stored', () => {
  assert.deepEqual(envStartArgs(repo({ enabled: true, memory: 8, rosetta: true, profileKey: '/old/r', vmType: 'qemu' }), 'feat', 'compose.yml').settings, { enabled: true, memory: 8, rosetta: true, composeFile: 'compose.yml' })
  const odd = { enabled: 'yes', cpu: '4', memory: Number.NaN, disk: Infinity, networkAddress: 1, rosetta: false }
  assert.deepEqual(envStartArgs(repo(odd), 'feat', 'c.yml').settings, { enabled: true, rosetta: false, composeFile: 'c.yml' })
})

test('the default compose file is not sent: the server reads it unconfined, as before 5a (a symlinked docker-compose.yml)', () => {
  for (const unset of [undefined, '', 'docker-compose.yml']) assert.equal(composeFileArg(unset), undefined)
  for (const chosen of ['compose.dev.yaml', 'docker-compose.yml,compose.dev.yaml', 'sub/docker-compose.yml']) assert.equal(composeFileArg(chosen), chosen)
  assert.deepEqual(envStartArgs(repo({ enabled: true, memory: 1.5 }), 'feat', 'docker-compose.yml').settings, { enabled: true, memory: 1.5 })
})

test("the Env panel's log follows the profile env.up actually used: the first step of a run it started", () => {
  const filter = createRunLogFilter()
  assert.equal(filter.accepts('twb-old', { profile: 'twb-old', data: 'x' }), true)
  assert.equal(filter.accepts('twb-old', { profile: 'twb-new', data: '', step: 'vm' }), false)
  filter.begin()
  assert.equal(filter.accepts('twb-old', { profile: 'twb-other', data: 'a stop elsewhere' }), false)
  assert.equal(filter.accepts('twb-old', { profile: 'twb-new', data: '', step: 'vm' }), true)
  assert.equal(filter.accepts('twb-old', { profile: 'twb-new', data: 'booting' }), true)
  assert.equal(filter.accepts('twb-old', { profile: 'twb-third', data: '', step: 'vm' }), false)
  filter.end()
  assert.equal(filter.accepts('twb-old', { profile: 'twb-new', data: 'late' }), false)
})

test("a server window's Start right after typing uses the variables still pending on the server: host.repos() shows the window's overlay", () => {
  const mirror = {
    id: 'p', name: 'P', settings: {}, globalSessions: [],
    repositories: [{ id: 'r1', name: 'alpha', path: '/a', branchData: { feat: { env: 'OLD=1', pluginSettings: { env: { env: 'OLD=1' } } } }, worktrees: [] }]
  }
  const never = () => new Promise(() => {})
  const requests = { updateSettings: never, rename: never, setLinkedDirs: never, setEnvironments: never, setBranchEnv: never, setRepoPluginSettings: never, setBranchPluginSettings: never }
  const writer = createSettingsWriter({ project: () => mirror, changed: () => {}, askConflict: async () => 'reload', reload: () => {}, reportEdit: () => {} })
  const o = v2SettingsOverrides(writer, requests, () => mirror)
  // The textarea's blur commits; the server has not answered yet.
  o.setPluginBranchSettings('env', 'r1', 'feat', { env: 'NEW=2' }, 'Colima environments')
  const reposOf = (project) => {
    const { slice } = projectV2(project)
    return pluginReposOf(slice.project, slice.hostWorktrees, 'env', () => undefined)
  }
  assert.deepEqual(envStartArgs(reposOf(writer.overlay(mirror))[0], 'feat', 'compose.yml').envVars, { NEW: '2' })
  assert.deepEqual(envStartArgs(reposOf(mirror)[0], 'feat', 'compose.yml').envVars, { OLD: '1' }, 'without the overlay: the old ones')
})

test("the settings: on, the VM key (an absolute profileKey, else the path), a branch's .env, a patch over what is shown", () => {
  assert.equal(envOn(repo({ enabled: true })), true)
  assert.equal(envOn(repo({ enabled: 'yes' })), false)
  assert.equal(envOn(undefined), false)
  assert.equal(repoKeyOf(repo({ profileKey: '/old/r' })), '/old/r')
  assert.equal(repoKeyOf(repo({ profileKey: 'relative' })), '/r')
  assert.equal(branchVars(repo({}, { feat: { env: 'A=1' } }), 'feat'), 'A=1')
  assert.equal(branchVars(repo(), 'feat'), '')
  assert.deepEqual(patchedSettings(repo({ enabled: true, cpu: 4, composeFile: 'a.yml' }), { cpu: 2, composeFile: undefined }), { enabled: true, cpu: 2 })
  assert.deepEqual(patchedSettings(repo(), { cpu: 3 }), { enabled: false, cpu: 3 }, '`enabled` always there, as the old object had it')
})

test("withBranchVars: the branch's values with its .env text set, '' included (the window's setter routes an empty one), its other keys kept", () => {
  assert.deepEqual(withBranchVars(repo({}, { feat: { env: 'A=1', later: true } }), 'feat', 'B=2'), { env: 'B=2', later: true })
  assert.deepEqual(withBranchVars(repo({}, { feat: { env: 'A=1' } }), 'feat', ''), { env: '' })
  assert.deepEqual(withBranchVars(repo(), 'feat', 'C=3'), { env: 'C=3' })
  assert.deepEqual(withBranchVars(undefined, 'feat', 'C=3'), { env: 'C=3' })
})

test("the Env panel's clear, end to end: withBranchVars's `env: ''` over a .env held only in the old field goes through branch.setEnv as null, guarded by the old text", () => {
  const big = 'A=' + 'x'.repeat(100_001)
  const mirror = { id: 'p', name: 'P', settings: {}, globalSessions: [], repositories: [{ id: 'r1', name: 'alpha', path: '/a', branchData: { feat: { env: big } }, worktrees: [] }] }
  const calls = []
  const record = (name) => async (...args) => void calls.push([name, ...args])
  const requests = Object.fromEntries(['updateSettings', 'rename', 'setLinkedDirs', 'setEnvironments', 'setBranchEnv', 'setRepoPluginSettings', 'setBranchPluginSettings'].map((n) => [n, record(n)]))
  const writer = createSettingsWriter({ project: () => mirror, changed: () => {}, askConflict: async () => 'reload', reload: () => {}, reportEdit: () => {} })
  const o = v2SettingsOverrides(writer, requests, () => mirror)
  const { slice } = projectV2(mirror)
  const [shown] = pluginReposOf(slice.project, slice.hostWorktrees, 'env', () => undefined)
  assert.equal(branchVars(shown, 'feat'), big, 'the panel shows the old text')
  o.setPluginBranchSettings('env', 'r1', 'feat', withBranchVars(shown, 'feat', ''), 'Colima environments')
  assert.deepEqual(calls, [['setBranchEnv', 'r1', 'feat', null, big]])
})

test("envPanelEntry: the Env entry where the repository has environments on and the worktree is on a branch; its dot from the poll's VM and its operation", () => {
  const store = useColimaStore.getState()
  store.reset()
  const on = fakeHost([repo({ enabled: true })])
  assert.deepEqual(envPanelEntry(on, feat), { label: 'Env', title: 'Isolated Docker environment for this worktree' }, 'no VM known yet: no dot')
  assert.equal(envPanelEntry(fakeHost([repo({ enabled: false })]), feat), null)
  assert.equal(envPanelEntry(on, { ...feat, branch: undefined }), null)
  store.setEnvironments([vm('running')])
  assert.equal(envPanelEntry(on, feat).dot, 'running')
  store.setBusy(profile, 'stop')
  assert.equal(envPanelEntry(on, feat).dot, 'attention')
  store.setBusy(profile, null)
  store.setEnvironments([vm('stopped')])
  assert.equal(envPanelEntry(on, feat).dot, 'exited')
  store.reset()
})

test("refreshEnvironments: the enabled repositories' VMs once the tool check passed; a registry it can't read says so; a stale host's answer is dropped", async () => {
  const store = useColimaStore.getState()
  store.reset()
  const asked = []
  let current = true
  let answer = async () => [vm('running')]
  const host = fakeHost([repo({ enabled: true }), repo({}, {}, { id: 'off', path: '/off' })], {
    request: async (method, params) => (asked.push([method, params.repoId]), answer()),
    isCurrent: () => current
  })
  await refreshEnvironments(host)
  assert.deepEqual(asked, [], 'no tool check yet: nothing listed')
  store.setToolCheck({ ok: true })
  await refreshEnvironments(host)
  assert.deepEqual(asked, [['list', 'r']])
  assert.deepEqual(Object.keys(useColimaStore.getState().environments), [profile])
  answer = async () => {
    throw Object.assign(new Error('The environments registry /d/environments.json cannot be read (bad json); it was left as it is'), { code: 'TOOL_ERROR', details: { reason: 'registry' } })
  }
  await refreshEnvironments(host)
  assert.match(useColimaStore.getState().listError, /cannot be read/)
  answer = async () => []
  current = false
  await refreshEnvironments(host)
  assert.deepEqual(Object.keys(useColimaStore.getState().environments), [profile], 'the window moved on: its answer is dropped')
  store.reset()
})

test('the old-server fallback: the VM as the confirm says it; run deletes it through the host (a warning, never a rejection); a running VM keeps its repository', async () => {
  const store = useColimaStore.getState()
  store.reset()
  const sent = []
  let fail = false
  const host = fakeHost([repo({ enabled: true })], {
    request: async (method, params, options) => {
      sent.push([method, params, options])
      if (method === 'destroy' && fail) throw new Error('colima delete failed')
      return 0
    }
  })
  assert.equal(colimaLegacyTeardown.part(host, feat), null, 'no VM known')
  store.setEnvironments([vm('running')])
  assert.deepEqual(colimaLegacyTeardown.part(host, feat), {
    label: `its VM “${profile}”`,
    notice: `Its Docker environment (Colima VM “${profile}”) and all its data will also be deleted.`,
    running: true
  })
  assert.equal(colimaLegacyTeardown.repoRemoveBlock(host, repo({ enabled: true })), 'It has a running environment. Stop it in the Env tab first.')
  assert.equal(colimaLegacyTeardown.repoRemoveBlock(host, repo({ enabled: true }, {}, { id: 'other', path: '/other' })), null)
  assert.equal(await colimaLegacyTeardown.run(host, feat), undefined)
  assert.deepEqual(sent[0], ['destroy', { profile }, { timeoutMs: 600_000 }])
  fail = true
  assert.match(await colimaLegacyTeardown.run(host, feat), /^Failed to remove environment VM ".+": Error: colima delete failed\. It is listed under Orphaned environments in Settings\.$/)
  assert.deepEqual(useColimaStore.getState().busy, {}, 'not busy after either')
  store.reset()
})
