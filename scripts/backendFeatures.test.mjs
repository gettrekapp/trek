// scripts/backendFeatures.test.mjs — the feature sets a window backend reports.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FEATURE_NAMES,
  NO_FEATURES,
  SETTINGS_SECTIONS,
  V2_FEATURES,
  globalPanelMode,
  settingsSections,
  v2Features
} from '../src/renderer/src/backendFeatures.ts'

test('both sets name exactly the known features', () => {
  const names = [...FEATURE_NAMES].sort()
  assert.deepEqual(Object.keys(NO_FEATURES).sort(), names)
  assert.deepEqual(Object.keys(V2_FEATURES).sort(), names)
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length)
})

test('an empty window has no feature (4e: no file windows)', () => {
  for (const name of FEATURE_NAMES) assert.equal(NO_FEATURES[name], false, name)
})

test('a server window can have settings editing, the Global panel, the server\'s features and this machine\'s', () => {
  const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'voice', 'skills', 'prWatch', 'review', 'moveWorktree', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
})

test('moving a worktree to another server follows move (5d)', () => {
  assert.equal(v2Features(['move']).moveWorktree, true)
  assert.equal(v2Features(['review', 'mcp']).moveWorktree, false)
})

test('the Changes tab review follows review (5c-2): an older server has only the branch view', () => {
  assert.equal(v2Features(['review']).review, true)
  assert.equal(v2Features(['mcp', 'linear', 'voice', 'skills', 'local'], { localEntry: true }).review, false)
})

test('the pull request watch follows prWatch (5c-1): listed only while gh is signed in on the server', () => {
  assert.equal(v2Features(['prWatch']).prWatch, true)
  assert.equal(v2Features(['mcp', 'local', 'linear'], { localEntry: true }).prWatch, false)
})

test('v2 features are the ceiling AND the welcome capabilities; settings need none', () => {
  const on = (caps, options) => FEATURE_NAMES.filter((name) => v2Features(caps, options)[name])
  assert.deepEqual(on(['mcp']), ['settingsEdit', 'globalPanel'])
  assert.deepEqual(on([]), ['settingsEdit'])
  // Before the first welcome there are no capabilities.
  assert.deepEqual(on(undefined), ['settingsEdit'])
  // A capability the ceiling has off turns nothing on.
  assert.deepEqual(on(['mcp', 'bot', 'moveWorktree']), ['settingsEdit', 'globalPanel'])
})

test('Linear, voice and skills are the server\'s (5b): each follows its own capability, on any server', () => {
  const on = (caps, options) => ['linear', 'voice', 'skills'].filter((name) => v2Features(caps, options)[name])
  assert.deepEqual(on(['linear', 'voice', 'skills']), ['linear', 'voice', 'skills'])
  assert.deepEqual(on(['voice']), ['voice'])
  // A server older than 5b: none, even on the Local entry with `local`.
  assert.deepEqual(on(['mcp', 'local', 'docker'], { localEntry: true }), [])
})

test("docker, env and stacks run on the server's machine: each follows its own capability, on any server (5a)", () => {
  const on = (caps, options) => ['docker', 'env', 'stacks'].filter((name) => v2Features(caps, options)[name])
  assert.deepEqual(on(['mcp', 'docker', 'env', 'stacks']), ['docker', 'env', 'stacks'])
  assert.deepEqual(on(['docker']), ['docker'])
  assert.deepEqual(on(['env', 'stacks']), ['env', 'stacks'])
  // A server older than 5a: none, even on the Local entry with `local`.
  assert.deepEqual(on(['mcp', 'local'], { localEntry: true }), [])
  // The Local entry needs nothing more than the capabilities.
  assert.deepEqual(on(['docker', 'env', 'stacks'], { localEntry: false }), ['docker', 'env', 'stacks'])
})

test("the settings sections: a server window shows what its server has and keeps the project's agents", () => {
  const v2 = settingsSections(v2Features(['mcp', 'linear']))
  assert.deepEqual(Object.keys(v2), [...SETTINGS_SECTIONS])
  const by = (mode) => SETTINGS_SECTIONS.filter((name) => v2[name] === mode)
  // Linear's key is the server's (5b): shown where it serves linear.*; voice and the environments where it has them.
  assert.deepEqual(by('hidden'), ['voice', 'environments'])
  assert.deepEqual(SETTINGS_SECTIONS.filter((name) => settingsSections(v2Features([]))[name] === 'hidden'), ['linear', 'voice', 'environments'])
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

const MACHINE = ['reveal', 'openInEditor']
const SERVER_MACHINE = ['mcp', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills']

test("the Local entry's server, welcomed with `local`, has this machine's features too", () => {
  const on = (caps, options) => FEATURE_NAMES.filter((name) => v2Features(caps, options)[name])
  assert.deepEqual(on([...SERVER_MACHINE, 'local'], { localEntry: true }), [
    'docker',
    'env',
    'stacks',
    'linear',
    'voice',
    'skills',
    'reveal',
    'openInEditor',
    'settingsEdit',
    'globalPanel'
  ])
  // Never the bot, moving worktrees or promote (phase 5).
  for (const name of ['bot', 'moveWorktree', 'promote']) assert.equal(v2Features([...SERVER_MACHINE, 'local'], { localEntry: true })[name], false, name)
})

test("this machine's features need both the Local entry and the `local` capability", () => {
  const any = (caps, options) => MACHINE.filter((name) => v2Features(caps, options)[name])
  // A saved entry whose server says `local` (a tunnel to another machine's Local server): its paths are not on this disk.
  assert.deepEqual(any([...SERVER_MACHINE, 'local']), [])
  assert.deepEqual(any([...SERVER_MACHINE, 'local'], { localEntry: false }), [])
  // The Local entry before its welcome, or a server there that is not a Local one.
  assert.deepEqual(any(undefined, { localEntry: true }), [])
  assert.deepEqual(any(SERVER_MACHINE, { localEntry: true }), [])
})

test('a connected server older than 5b (no linear or voice) shows a hint to update it in their place', () => {
  const older = settingsSections(v2Features(['mcp', 'env']), { connected: true })
  assert.deepEqual([older.linear, older.voice, older.environments], ['needsUpdate', 'needsUpdate', 'edit'])
  // Not connected (connecting, offline, an empty window): nothing is known, so they are hidden.
  const offline = settingsSections(v2Features(['mcp', 'env']), { connected: false })
  assert.deepEqual([offline.linear, offline.voice], ['hidden', 'hidden'])
  // Environments are a machine's, not a version's: still hidden without env.
  assert.equal(settingsSections(v2Features(['linear', 'voice']), { connected: true }).environments, 'hidden')
  const current = settingsSections(v2Features(['linear', 'voice']), { connected: true })
  assert.deepEqual([current.linear, current.voice], ['edit', 'edit'])
})

test('a window whose server runs environments and has Linear and voice shows them in Settings, on Local or not', () => {
  for (const [caps, options] of [[[...SERVER_MACHINE, 'local'], { localEntry: true }], [SERVER_MACHINE, {}]]) {
    const sections = settingsSections(v2Features(caps, options))
    assert.deepEqual(SETTINGS_SECTIONS.filter((name) => sections[name] === 'hidden'), [])
    assert.deepEqual([sections.environments, sections.linear, sections.voice, sections.agents], ['edit', 'edit', 'edit', 'project'])
  }
})

test('the same capabilities give the same object, so a React snapshot read is stable', () => {
  assert.equal(v2Features(['mcp']), v2Features(['mcp']))
  assert.equal(v2Features([]), v2Features(undefined))
  assert.notEqual(v2Features(['mcp']), v2Features([]))
  assert.equal(v2Features(['local', 'mcp'], { localEntry: true }), v2Features(['mcp', 'local'], { localEntry: true }))
  assert.notEqual(v2Features(['mcp', 'local'], { localEntry: true }), v2Features(['mcp', 'local']))
})

test('the Global panel without its capability shows the sessions it has, read-only, and hides when there are none', () => {
  assert.equal(globalPanelMode(v2Features(['mcp']), 0), 'full')
  assert.equal(globalPanelMode(v2Features([]), 2), 'readOnly')
  assert.equal(globalPanelMode(v2Features([]), 0), 'hidden')
})
