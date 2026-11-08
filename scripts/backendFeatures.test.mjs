// scripts/backendFeatures.test.mjs — the feature sets a window backend reports.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FEATURE_NAMES,
  LEGACY_FEATURES,
  SETTINGS_SECTIONS,
  V2_FEATURES,
  globalPanelMode,
  settingsSections,
  v2Features
} from '../src/renderer/src/backendFeatures.ts'

test('both sets name exactly the known features', () => {
  const names = [...FEATURE_NAMES].sort()
  assert.deepEqual(Object.keys(LEGACY_FEATURES).sort(), names)
  assert.deepEqual(Object.keys(V2_FEATURES).sort(), names)
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length)
})

test('a project file window keeps every feature', () => {
  for (const name of FEATURE_NAMES) assert.equal(LEGACY_FEATURES[name], true, name)
})

test('a server window can have Linear, settings editing, the Global panel and the machine-local features', () => {
  const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'skills', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
})

test('v2 features are the ceiling AND the welcome capabilities; Linear and settings need none', () => {
  const on = (caps, options) => FEATURE_NAMES.filter((name) => v2Features(caps, options)[name])
  assert.deepEqual(on(['mcp']), ['linear', 'settingsEdit', 'globalPanel'])
  assert.deepEqual(on([]), ['linear', 'settingsEdit'])
  // Before the first welcome there are no capabilities.
  assert.deepEqual(on(undefined), ['linear', 'settingsEdit'])
  // A capability the ceiling has off turns nothing on.
  assert.deepEqual(on(['mcp', 'docker', 'bot']), ['linear', 'settingsEdit', 'globalPanel'])
})

test("the settings sections: a file window edits all; a server window hides this machine's and keeps the project's agents", () => {
  const legacy = settingsSections('legacy', LEGACY_FEATURES)
  assert.deepEqual(Object.keys(legacy), [...SETTINGS_SECTIONS])
  for (const name of SETTINGS_SECTIONS) assert.equal(legacy[name], 'edit', name)
  const v2 = settingsSections('v2', v2Features(['mcp']))
  const by = (mode) => SETTINGS_SECTIONS.filter((name) => v2[name] === mode)
  // Linear's key is app-wide and it reads ticket ids only: shown on every server (4c).
  assert.deepEqual(by('hidden'), ['voice', 'environments', 'remoteHosts'])
  assert.deepEqual(by('project'), ['agents'])
  assert.deepEqual(by('edit'), [
    'sessionMode',
    'audioAlerts',
    'linkedDirs',
    'appearance',
    'linear',
    'worktreeTags',
    'customTags',
    'terminalButtons',
    'sessionPrompt',
    'globalPrompt',
    'globalButtons',
    'sessionTypes'
  ])
})

const MACHINE = ['docker', 'env', 'stacks', 'skills', 'reveal', 'openInEditor']

test("the Local entry's server, welcomed with `local`, has the machine-local features", () => {
  const on = (caps, options) => FEATURE_NAMES.filter((name) => v2Features(caps, options)[name])
  assert.deepEqual(on(['mcp', 'local'], { localEntry: true }), [
    'docker',
    'env',
    'stacks',
    'linear',
    'skills',
    'reveal',
    'openInEditor',
    'settingsEdit',
    'globalPanel'
  ])
  // Never the bot, voice, moving worktrees or promote (phase 5).
  for (const name of ['bot', 'voice', 'moveWorktree', 'promote']) assert.equal(v2Features(['mcp', 'local'], { localEntry: true })[name], false, name)
})

test('the machine-local features need both the Local entry and the `local` capability', () => {
  const any = (caps, options) => MACHINE.filter((name) => v2Features(caps, options)[name])
  // A saved entry whose server says `local` (a tunnel to another machine's Local server): its paths are not on this disk.
  assert.deepEqual(any(['mcp', 'local']), [])
  assert.deepEqual(any(['mcp', 'local'], { localEntry: false }), [])
  // The Local entry before its welcome, or a server there that is not a Local one.
  assert.deepEqual(any(undefined, { localEntry: true }), [])
  assert.deepEqual(any(['mcp'], { localEntry: true }), [])
})

test('a Local window also shows the environments; voice and the remote hosts stay hidden', () => {
  const local = settingsSections('v2', v2Features(['mcp', 'local'], { localEntry: true }))
  const hidden = SETTINGS_SECTIONS.filter((name) => local[name] === 'hidden')
  assert.deepEqual(hidden, ['voice', 'remoteHosts'])
  assert.equal(local.environments, 'edit')
  assert.equal(local.linear, 'edit')
  assert.equal(local.agents, 'project')
})

test('the same capabilities give the same object, so a React snapshot read is stable', () => {
  assert.equal(v2Features(['mcp']), v2Features(['mcp']))
  assert.equal(v2Features([]), v2Features(undefined))
  assert.notEqual(v2Features(['mcp']), v2Features([]))
  assert.equal(v2Features(['local', 'mcp'], { localEntry: true }), v2Features(['mcp', 'local'], { localEntry: true }))
  assert.notEqual(v2Features(['mcp', 'local'], { localEntry: true }), v2Features(['mcp', 'local']))
})

test('the Global panel without its capability shows the sessions it has, read-only, and hides when there are none', () => {
  assert.equal(globalPanelMode(LEGACY_FEATURES, 0), 'full')
  assert.equal(globalPanelMode(v2Features(['mcp']), 0), 'full')
  assert.equal(globalPanelMode(v2Features([]), 2), 'readOnly')
  assert.equal(globalPanelMode(v2Features([]), 0), 'hidden')
})
