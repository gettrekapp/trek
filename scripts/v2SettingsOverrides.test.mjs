// scripts/v2SettingsOverrides.test.mjs — the settings setters a server window sends to its server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_SETTERS, rebaseObject, rebaseSet, v2SettingsOverrides } from '../src/renderer/src/v2/settingsOverrides.ts'
import { OVERRIDDEN_SETTERS } from '../src/renderer/src/v2/setterOverrides.ts'
import { createSettingsWriter } from '../src/renderer/src/v2/settingsWriter.ts'

const project = () => ({
  id: 'p',
  name: 'Demo',
  settings: { audioAlerts: false, sessionSystemPrompt: 'Run the tests', worktreeTags: [{ id: 'todo', name: 'To do', color: '#fff' }], dockerFavorites: ['db'] },
  repositories: [
    { id: 'r1', name: 'alpha', path: '/a', linkedDirs: ['.trek'], branchData: {}, worktrees: [] },
    { id: 'r2', name: 'beta', path: '/b', environments: { enabled: true, cpu: 4 }, branchData: {}, worktrees: [] }
  ],
  globalSessions: []
})

/** Overrides over a real writer whose requests are recorded and resolve at once. */
function setup() {
  const calls = []
  const requests = {
    updateSettings: async (settings, expected) => void calls.push(['updateSettings', settings, expected]),
    rename: async (name, expected) => void calls.push(['rename', name, expected]),
    setLinkedDirs: async (repoId, dirs, expected) => void calls.push(['setLinkedDirs', repoId, dirs, expected]),
    setEnvironments: async (repoId, environments, expected) => void calls.push(['setEnvironments', repoId, environments, expected]),
    setBranchEnv: async (repoId, branch, env, expected) => void calls.push(['setBranchEnv', repoId, branch, env, expected])
  }
  const mirror = project()
  const writer = createSettingsWriter({
    project: () => mirror,
    changed: () => {},
    askConflict: async () => 'reload',
    reload: () => {},
    reportEdit: () => {}
  })
  return { o: v2SettingsOverrides(writer, requests, () => mirror), calls, writer, mirror }
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

test("a Local window's environment settings: the repository's whole setting through repo.update, built on what is shown", () => {
  const { o, calls, writer, mirror } = setup()
  o.setEnvironmentSettings('r1', { enabled: true })
  // The second edit builds on the first, still pending: the overlay is what the panel shows.
  o.setEnvironmentSettings('r1', { cpu: 2 })
  o.setEnvironmentSettings('r2', { memory: 16 })
  assert.deepEqual(calls, [
    ['setEnvironments', 'r1', { enabled: true }, null],
    ['setEnvironments', 'r2', { enabled: true, cpu: 4, memory: 16 }, { enabled: true, cpu: 4 }]
  ])
  // r1's second edit waits for the first (one request per field) and shows meanwhile.
  assert.deepEqual(writer.overlay(mirror).repositories[0].environments, { enabled: true, cpu: 2 })
  // An unknown repository sends nothing.
  o.setEnvironmentSettings('nope', { enabled: true })
  assert.equal(calls.length, 2)
})

test('a Docker favourite toggles in the dockerFavorites setting, sorted, and the last one off removes the key', () => {
  const { o, calls, writer, mirror } = setup()
  o.toggleDockerFavorite('api')
  assert.deepEqual(calls, [['updateSettings', { dockerFavorites: ['api', 'db'] }, { dockerFavorites: ['db'] }]])
  assert.deepEqual(writer.overlay(mirror).settings.dockerFavorites, ['api', 'db'])
  const off = setup()
  off.o.toggleDockerFavorite('db')
  assert.deepEqual(off.calls, [['updateSettings', { dockerFavorites: null }, { dockerFavorites: ['db'] }]])
})

class CodedError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}
const tick = () => new Promise((r) => setImmediate(r))

/**
 * Overrides over a real writer whose sends stay open: `ok()` writes the value
 * into the mirror (as its patch would), `conflict(edit)` first lets another
 * client's edit land, then answers CONFLICT.
 */
function pendingSetup() {
  const sends = []
  const asked = []
  const mirror = project()
  const open = (name, args, write) =>
    new Promise((resolve, reject) => {
      sends.push({
        name,
        args,
        ok: () => {
          write()
          resolve()
        },
        conflict: (other) => {
          other(mirror)
          reject(new CodedError('CONFLICT'))
        }
      })
    })
  const requests = {
    updateSettings: (settings, expected) =>
      open('updateSettings', [settings, expected], () => {
        for (const [k, v] of Object.entries(settings)) {
          if (v === null) delete mirror.settings[k]
          else mirror.settings[k] = v
        }
      }),
    rename: async () => {},
    setLinkedDirs: async () => {},
    setEnvironments: (repoId, environments, expected) =>
      open('setEnvironments', [repoId, environments, expected], () => {
        mirror.repositories.find((r) => r.id === repoId).environments = environments ?? undefined
      }),
    setBranchEnv: (repoId, branch, env, expected) =>
      open('setBranchEnv', [repoId, branch, env, expected], () => {
        const repo = mirror.repositories.find((r) => r.id === repoId)
        repo.branchData[branch] = { ...repo.branchData[branch], env: env ?? undefined }
      })
  }
  const choices = []
  const writer = createSettingsWriter({
    project: () => mirror,
    changed: () => {},
    askConflict: async (label) => {
      asked.push(label)
      return choices.shift() ?? 'reload'
    },
    reload: () => {},
    reportEdit: () => {}
  })
  return { o: v2SettingsOverrides(writer, requests, () => mirror), sends, asked, choices, writer, mirror }
}

test('rebaseSet: the items added and removed are applied to the newer set, never a clash', () => {
  assert.deepEqual(rebaseSet(['db', 'web'], ['api', 'db'], ['db']), { value: ['api', 'db', 'web'], clash: false })
  assert.deepEqual(rebaseSet(['db', 'web'], null, ['db']), { value: ['web'], clash: false })
  assert.deepEqual(rebaseSet(null, null, ['db']), { value: null, clash: false })
})

test('rebaseObject: the keys changed go over the newer object; a clash only when it changed the same key differently', () => {
  assert.deepEqual(rebaseObject({ enabled: true, cpu: 8 }, { enabled: true, cpu: 4, memory: 16 }, { enabled: true, cpu: 4 }), {
    value: { enabled: true, cpu: 8, memory: 16 },
    clash: false
  })
  assert.deepEqual(rebaseObject({ enabled: true, cpu: 8 }, { enabled: true, cpu: 2 }, { enabled: true, cpu: 4 }), {
    value: { enabled: true, cpu: 2 },
    clash: true
  })
  // The same change made by both is no clash.
  assert.deepEqual(rebaseObject({ cpu: 2 }, { cpu: 2 }, { cpu: 4 }).clash, false)
})

test('a Docker favourite toggle that meets a CONFLICT is toggled again on the newer list, silently, once', async () => {
  const { o, sends, asked, mirror } = pendingSetup()
  o.toggleDockerFavorite('api')
  assert.deepEqual(sends[0].args, [{ dockerFavorites: ['api', 'db'] }, { dockerFavorites: ['db'] }])
  // Another client adds "web" first.
  sends[0].conflict((m) => (m.settings.dockerFavorites = ['db', 'web']))
  await tick()
  assert.deepEqual(asked, [])
  assert.deepEqual(sends[1].args, [{ dockerFavorites: ['api', 'db', 'web'] }, { dockerFavorites: ['db', 'web'] }])
  // A second CONFLICT asks (once is enough silently); Reload drops it.
  sends[1].conflict((m) => (m.settings.dockerFavorites = ['web']))
  await tick()
  await tick()
  assert.deepEqual(asked, ['Docker favourites'])
  assert.equal(sends.length, 2)
  assert.deepEqual(mirror.settings.dockerFavorites, ['web'])
})

test('a toggle whose rebase leaves the newer list as it is sends nothing more', async () => {
  const { o, sends, asked } = pendingSetup()
  o.toggleDockerFavorite('api')
  sends[0].conflict((m) => (m.settings.dockerFavorites = ['api', 'db']))
  await tick()
  assert.deepEqual([sends.length, asked], [1, []])
})

test("an environment sub-field set meets a CONFLICT: it goes over the other client's other sub-fields, silently", async () => {
  const { o, sends, asked } = pendingSetup()
  o.setEnvironmentSettings('r2', { memory: 16 })
  sends[0].conflict((m) => (m.repositories[1].environments = { enabled: true, cpu: 8, disk: 100 }))
  await tick()
  assert.deepEqual(asked, [])
  assert.deepEqual(sends[1].args, ['r2', { enabled: true, cpu: 8, disk: 100, memory: 16 }, { enabled: true, cpu: 8, disk: 100 }])
})

test('an environment sub-field the other client changed too asks; Keep Mine keeps its other sub-fields', async () => {
  const { o, sends, asked, choices } = pendingSetup()
  choices.push('keep')
  o.setEnvironmentSettings('r2', { cpu: 2 })
  sends[0].conflict((m) => (m.repositories[1].environments = { enabled: true, cpu: 8, disk: 100 }))
  await tick()
  await tick()
  assert.deepEqual(asked, ['Docker environments'])
  assert.deepEqual(sends[1].args, ['r2', { enabled: true, cpu: 2, disk: 100 }, { enabled: true, cpu: 8, disk: 100 }])
})

test("a branch's environment variables: branch.setEnv with expected, and shown pending in the overlay", async () => {
  const { o, sends, writer, mirror } = pendingSetup()
  o.setBranchEnvVars('r1', 'feat', 'A=1')
  assert.deepEqual(sends[0].args, ['r1', 'feat', 'A=1', null])
  // What the panel's Start reads before the server has answered.
  assert.equal(writer.overlay(mirror).repositories[0].branchData.feat.env, 'A=1')
  assert.equal(mirror.repositories[0].branchData.feat, undefined)
  // An edit made meanwhile goes next, expecting the first.
  o.setBranchEnvVars('r1', 'feat', '')
  assert.equal('feat' in writer.overlay(mirror).repositories[0].branchData, false, 'cleared, and the empty entry goes')
  sends[0].ok()
  await tick()
  assert.deepEqual(sends[1].args, ['r1', 'feat', null, 'A=1'])
})

test("a branch's environment variables changed elsewhere: the CONFLICT asks Reload or Keep Mine", async () => {
  const { o, sends, asked, choices } = pendingSetup()
  choices.push('keep')
  o.setBranchEnvVars('r1', 'feat', 'A=1')
  sends[0].conflict((m) => (m.repositories[0].branchData.feat = { env: 'B=2' }))
  await tick()
  await tick()
  assert.deepEqual(asked, ['Environment variables of feat'])
  assert.deepEqual(sends[1].args, ['r1', 'feat', 'A=1', 'B=2'])
})
