// scripts/environmentStart.test.mjs — what Start / Apply compose passes to envUp, and that it is the pending value.
import test from 'node:test'
import assert from 'node:assert/strict'
import { composeFileArg, envStartArgs, createRunLogFilter } from '../src/renderer/src/environmentStart.ts'
import { v2SettingsOverrides } from '../src/renderer/src/v2/settingsOverrides.ts'
import { createSettingsWriter } from '../src/renderer/src/v2/settingsWriter.ts'
import { projectV2 } from '../src/renderer/src/v2/projector.ts'

test('envStartArgs: the branch variables parsed, the repository settings with the chosen compose file', () => {
  const repo = { id: 'r', name: 'r', path: '/r', environments: { enabled: false, cpu: 4 }, branchEnvVars: { feat: 'A=1\nB=2' } }
  assert.deepEqual(envStartArgs(repo, 'feat', 'compose.yml'), {
    settings: { enabled: false, cpu: 4, composeFile: 'compose.yml' },
    envVars: { A: '1', B: '2' }
  })
  assert.deepEqual(envStartArgs(repo, 'other', 'c.yml'), { settings: { enabled: false, cpu: 4, composeFile: 'c.yml' }, envVars: undefined })
  assert.deepEqual(envStartArgs(undefined, 'feat', 'c.yml'), { settings: { enabled: true, composeFile: 'c.yml' }, envVars: undefined })
})

test('envStartArgs sends only the keys env.up takes: not a profileKey, nor what another client stored', () => {
  const repo = { id: 'r', name: 'r', path: '/r', environments: { enabled: true, memory: 8, rosetta: true, profileKey: '/old/r', vmType: 'qemu' } }
  assert.deepEqual(envStartArgs(repo, 'feat', 'compose.yml').settings, { enabled: true, memory: 8, rosetta: true, composeFile: 'compose.yml' })
})

test('envStartArgs copies only stored values of the right type: booleans for the flags, finite numbers for the sizes', () => {
  const environments = { enabled: 'yes', cpu: '4', memory: Number.NaN, disk: Infinity, networkAddress: 1, rosetta: false }
  assert.deepEqual(envStartArgs({ id: 'r', name: 'r', path: '/r', environments }, 'feat', 'c.yml').settings, { enabled: true, rosetta: false, composeFile: 'c.yml' })
  const good = { enabled: false, cpu: 2, memory: 6, disk: 40, networkAddress: true }
  assert.deepEqual(envStartArgs({ id: 'r', name: 'r', path: '/r', environments: good }, 'feat', 'c.yml').settings, { ...good, composeFile: 'c.yml' })
})

test('the default compose file is not sent: the server reads it unconfined, as before 5a (a symlinked docker-compose.yml)', () => {
  for (const unset of [undefined, '', 'docker-compose.yml']) assert.equal(composeFileArg(unset), undefined)
  for (const chosen of ['compose.dev.yaml', 'docker-compose.yml,compose.dev.yaml', 'sub/docker-compose.yml']) assert.equal(composeFileArg(chosen), chosen)
  const repo = { id: 'r', name: 'r', path: '/r', environments: { enabled: true, memory: 1.5 } }
  assert.deepEqual(envStartArgs(repo, 'feat', 'docker-compose.yml').settings, { enabled: true, memory: 1.5 })
  assert.equal('composeFile' in envStartArgs(repo, 'feat', '').settings, false)
  assert.deepEqual(envStartArgs(repo, 'feat', 'compose.dev.yaml').settings, { enabled: true, memory: 1.5, composeFile: 'compose.dev.yaml' })
})

test("the Env panel's log follows the profile env.up actually used: the first step of a run it started", () => {
  const filter = createRunLogFilter()
  // Not running: only the panel's own profile.
  assert.equal(filter.accepts('twb-old', { profile: 'twb-old', data: 'x' }), true)
  assert.equal(filter.accepts('twb-old', { profile: 'twb-new', data: '', step: 'vm' }), false)
  // A Start after a branch switch the poll has not seen: the server names the VM after the new branch.
  filter.begin()
  assert.equal(filter.accepts('twb-old', { profile: 'twb-other', data: 'a stop elsewhere' }), false)
  assert.equal(filter.accepts('twb-old', { profile: 'twb-new', data: '', step: 'vm' }), true)
  assert.equal(filter.accepts('twb-old', { profile: 'twb-new', data: 'booting' }), true)
  // Only the first step is adopted: another run's step later is not this one's.
  assert.equal(filter.accepts('twb-old', { profile: 'twb-third', data: '', step: 'vm' }), false)
  assert.equal(filter.accepts('twb-old', { profile: 'twb-old', data: 'own' }), true)
  filter.end()
  assert.equal(filter.accepts('twb-old', { profile: 'twb-new', data: 'late' }), false)
  // A run under the panel's own profile adopts it, so no later step is taken for this run's.
  filter.begin()
  assert.equal(filter.accepts('twb-old', { profile: 'twb-old', data: '', step: 'vm' }), true)
  assert.equal(filter.accepts('twb-old', { profile: 'twb-new', data: '', step: 'vm' }), false)
  filter.end()
})

test("a server window's Start right after typing uses the variables still pending on the server", () => {
  const mirror = {
    id: 'p',
    name: 'P',
    settings: {},
    repositories: [{ id: 'r1', name: 'alpha', path: '/a', branchData: { feat: { env: 'OLD=1' } }, worktrees: [] }],
    globalSessions: []
  }
  const never = () => new Promise(() => {})
  const requests = { updateSettings: never, rename: never, setLinkedDirs: never, setEnvironments: never, setBranchEnv: never }
  const writer = createSettingsWriter({
    project: () => mirror,
    changed: () => {},
    askConflict: async () => 'reload',
    reload: () => {},
    reportEdit: () => {}
  })
  const o = v2SettingsOverrides(writer, requests, () => mirror)
  // The textarea's blur commits; the server has not answered yet.
  o.setBranchEnvVars('r1', 'feat', 'NEW=2')
  // The store's project is the projection of the overlaid mirror.
  const shown = projectV2(writer.overlay(mirror)).slice.project
  assert.deepEqual(envStartArgs(shown.repositories[0], 'feat', 'compose.yml').envVars, { NEW: '2' })
  // Without the overlay (the old path), Start would have used the old ones.
  assert.deepEqual(envStartArgs(projectV2(mirror).slice.project.repositories[0], 'feat', 'compose.yml').envVars, { OLD: '1' })
})
