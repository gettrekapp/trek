// scripts/environmentStart.test.mjs — what Start / Apply compose passes to envUp, and that it is the pending value.
import test from 'node:test'
import assert from 'node:assert/strict'
import { envStartArgs } from '../src/renderer/src/environmentStart.ts'
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
