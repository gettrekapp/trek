// scripts/v2SettingsOverrides.test.mjs — the settings setters a server window sends to its server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_SETTERS, v2SettingsOverrides } from '../src/renderer/src/v2/settingsOverrides.ts'
import { OVERRIDDEN_SETTERS } from '../src/renderer/src/v2/setterOverrides.ts'
import { createSettingsWriter } from '../src/renderer/src/v2/settingsWriter.ts'

const project = () => ({
  id: 'p',
  name: 'Demo',
  settings: { audioAlerts: false, sessionSystemPrompt: 'Run the tests', worktreeTags: [{ id: 'todo', name: 'To do', color: '#fff' }] },
  repositories: [{ id: 'r1', name: 'alpha', path: '/a', linkedDirs: ['.trek'], branchData: {}, worktrees: [] }],
  globalSessions: []
})

/** Overrides over a real writer whose requests are recorded and resolve at once. */
function setup() {
  const calls = []
  const requests = {
    updateSettings: async (settings, expected) => void calls.push(['updateSettings', settings, expected]),
    rename: async (name, expected) => void calls.push(['rename', name, expected]),
    setLinkedDirs: async (repoId, dirs, expected) => void calls.push(['setLinkedDirs', repoId, dirs, expected])
  }
  const mirror = project()
  const writer = createSettingsWriter({
    project: () => mirror,
    changed: () => {},
    askConflict: async () => 'reload',
    reload: () => {},
    reportEdit: () => {}
  })
  return { o: v2SettingsOverrides(writer, requests), calls, writer, mirror }
}

test('overrides exactly the listed settings setters, none of them already overridden', () => {
  const { o } = setup()
  assert.deepEqual(Object.keys(o).sort(), [...SETTINGS_SETTERS].sort())
  assert.deepEqual(SETTINGS_SETTERS.filter((name) => OVERRIDDEN_SETTERS.includes(name)), [])
})

test('each setter sends its key in the server form, with the current value as expected', () => {
  const { o, calls } = setup()
  const type = { id: 't', name: 'Review', systemPrompt: '' }
  const button = { id: 'b', label: 'Go', text: 'go' }
  o.setAudioAlerts(true)
  o.setClaudePermissionMode(undefined)
  o.setClaudePermissionMode('plan')
  o.setTitleBarColor('#123456')
  o.setLogoImage(undefined)
  o.setSessionSystemPrompt('   ')
  o.setGlobalSystemPrompt('Be brief')
  o.setSessionTypes([type])
  o.setTerminalButtons([])
  o.setGlobalTerminalButtons([button])
  o.setWorktreeTags([])
  o.setCustomTags([])
  o.setProjectLlmDefault({ provider: 'codex' })
  o.setGlobalLlm(undefined)
  o.setLinearWorkspace('acme')
  o.setAzureDevOpsBaseUrl('')
  assert.deepEqual(calls, [
    ['updateSettings', { audioAlerts: true }, { audioAlerts: false }],
    ['updateSettings', { claudePermissionMode: 'plan' }, { claudePermissionMode: null }],
    ['updateSettings', { titleBarColor: '#123456' }, { titleBarColor: null }],
    ['updateSettings', { sessionSystemPrompt: null }, { sessionSystemPrompt: 'Run the tests' }],
    ['updateSettings', { globalSystemPrompt: 'Be brief' }, { globalSystemPrompt: null }],
    ['updateSettings', { sessionTypes: [type] }, { sessionTypes: null }],
    ['updateSettings', { globalTerminalButtons: [button] }, { globalTerminalButtons: null }],
    ['updateSettings', { worktreeTags: [] }, { worktreeTags: [{ id: 'todo', name: 'To do', color: '#fff' }] }],
    ['updateSettings', { llmDefault: { provider: 'codex' } }, { llmDefault: null }],
    ['updateSettings', { linearWorkspace: 'acme' }, { linearWorkspace: null }]
  ])
})

test('the project name goes through project.rename, linked directories through repo.update', () => {
  const { o, calls } = setup()
  o.setProjectName('Renamed')
  o.setLinkedDirs('r1', [])
  o.setLinkedDirs('nope', ['x'])
  assert.deepEqual(calls, [
    ['rename', 'Renamed', 'Demo'],
    ['setLinkedDirs', 'r1', null, ['.trek']],
    ['setLinkedDirs', 'nope', ['x'], null]
  ])
})

test('a pending edit shows in the overlaid project: settings, name and linked directories', () => {
  const { o, writer, mirror } = setup()
  o.setAudioAlerts(true)
  o.setSessionSystemPrompt('')
  o.setProjectName('Renamed')
  o.setLinkedDirs('r1', [])
  const shown = writer.overlay(mirror)
  assert.equal(shown.settings.audioAlerts, true)
  assert.equal('sessionSystemPrompt' in shown.settings, false)
  assert.equal(shown.name, 'Renamed')
  assert.equal('linkedDirs' in shown.repositories[0], false)
  assert.equal(mirror.settings.audioAlerts, false, 'the mirror itself is untouched')
})
