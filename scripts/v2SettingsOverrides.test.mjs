// scripts/v2SettingsOverrides.test.mjs — the settings setters a server window sends to its server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rebaseObject, rebaseSet, v2SettingsOverrides } from '../src/renderer/src/v2/settingsOverrides.ts'
import { createSettingsWriter } from '../src/renderer/src/v2/settingsWriter.ts'

const project = () => ({
  id: 'p',
  name: 'Demo',
  settings: { audioAlerts: false, sessionSystemPrompt: 'Run the tests', worktreeTags: [{ id: 'todo', name: 'To do', color: '#fff' }], dockerFavorites: ['db'] },
  repositories: [
    { id: 'r1', name: 'alpha', path: '/a', linkedDirs: ['.trek'], branchData: {}, worktrees: [] },
    { id: 'r2', name: 'beta', path: '/b', environments: { enabled: true, cpu: 4 }, pluginSettings: { env: { enabled: true, cpu: 4 }, other: { on: true } }, branchData: {}, worktrees: [] }
  ],
  globalSessions: []
})

/** Overrides over a real writer whose requests are recorded and resolve at once. */
function setup({ listsPlugin } = {}) {
  const calls = []
  const requests = {
    updateSettings: async (settings, expected) => void calls.push(['updateSettings', settings, expected]),
    rename: async (name, expected) => void calls.push(['rename', name, expected]),
    setLinkedDirs: async (repoId, dirs, expected) => void calls.push(['setLinkedDirs', repoId, dirs, expected]),
    setEnvironments: async (repoId, environments, expected) => void calls.push(['setEnvironments', repoId, environments, expected]),
    setBranchEnv: async (repoId, branch, env, expected) => void calls.push(['setBranchEnv', repoId, branch, env, expected]),
    setRepoPluginSettings: async (repoId, pluginId, values, expected) => void calls.push(['setRepoPluginSettings', repoId, pluginId, values, expected]),
    setBranchPluginSettings: async (repoId, branch, pluginId, values, expected) => void calls.push(['setBranchPluginSettings', repoId, branch, pluginId, values, expected])
  }
  const mirror = project()
  const writer = createSettingsWriter({
    project: () => mirror,
    changed: () => {},
    askConflict: async () => 'reload',
    reload: () => {},
    reportEdit: () => {}
  })
  return { o: v2SettingsOverrides(writer, requests, () => mirror, listsPlugin), calls, writer, mirror }
}

/** The store's SettingsSetter names (store.ts). */
const SETTINGS_SETTERS = [
  'setClaudePermissionMode',
  'setAudioAlerts',
  'setPluginEnabled',
  'setTitleBarColor',
  'setLogoImage',
  'setBannerImage',
  'setWorktreeTags',
  'setCustomTags',
  'setTerminalButtons',
  'setGlobalTerminalButtons',
  'setSessionSystemPrompt',
  'setGlobalSystemPrompt',
  'setSessionTypes',
  'setProjectLlmDefault',
  'setGlobalLlm',
  'setPluginSetting',
  'setProjectName',
  'setLinkedDirs',
  'setEnvironmentSettings',
  'toggleDockerFavorite',
  'setBranchEnvVars',
  'setPluginRepoSettings',
  'setPluginBranchSettings'
]

test("gives exactly the store's settings setters", () => {
  const { o } = setup()
  assert.deepEqual(Object.keys(o).sort(), [...SETTINGS_SETTERS].sort())
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
  o.setPluginSetting('linearWorkspace', 'acme')
  o.setPluginSetting('azureDevOpsBaseUrl', '')
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

test("setPluginEnabled sends the whole plugins setting, built on what the window shows (a pending edit kept)", async () => {
  const { o, calls } = setup()
  o.setPluginEnabled('voice', false)
  // The second edit of the field waits for the first, and builds on it.
  o.setPluginEnabled('other', true)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(calls, [
    ['updateSettings', { plugins: { voice: { enabled: false } } }, { plugins: null }],
    ['updateSettings', { plugins: { voice: { enabled: false }, other: { enabled: true } } }, { plugins: { voice: { enabled: false } } }]
  ])
})

test("a CONFLICT on plugins rebases per plugin: another window's switch is kept", async () => {
  const calls = []
  let conflicts = 1
  const mirror = project()
  const requests = {
    updateSettings: async (settings, expected) => {
      calls.push([settings, expected])
      if (conflicts-- > 0) {
        // Another window turned X off meanwhile.
        mirror.settings = { ...mirror.settings, plugins: { x: { enabled: false } } }
        throw Object.assign(new Error('changed'), { code: 'CONFLICT' })
      }
      mirror.settings = { ...mirror.settings, ...settings }
    },
    rename: async () => {},
    setLinkedDirs: async () => {},
    setEnvironments: async () => {},
    setBranchEnv: async () => {},
    setRepoPluginSettings: async () => {},
    setBranchPluginSettings: async () => {}
  }
  const asked = []
  const writer = createSettingsWriter({ project: () => mirror, changed: () => {}, askConflict: async (q) => (asked.push(q), 'reload'), reload: () => {}, reportEdit: () => {} })
  const o = v2SettingsOverrides(writer, requests, () => mirror)
  o.setPluginEnabled('voice', false)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(calls, [
    [{ plugins: { voice: { enabled: false } } }, { plugins: null }],
    [{ plugins: { x: { enabled: false }, voice: { enabled: false } } }, { plugins: { x: { enabled: false } } }]
  ])
  assert.deepEqual(asked, [], 'no clash: a different plugin')
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
function pendingSetup({ listsPlugin } = {}) {
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
      }),
    setRepoPluginSettings: (repoId, pluginId, values, expected) =>
      open('setRepoPluginSettings', [repoId, pluginId, values, expected], () => {
        const repo = mirror.repositories.find((r) => r.id === repoId)
        const next = { ...(repo.pluginSettings ?? {}) }
        if (Object.keys(values).length > 0) next[pluginId] = values
        else delete next[pluginId]
        repo.pluginSettings = next
      }),
    setBranchPluginSettings: (repoId, branch, pluginId, values, expected) =>
      open('setBranchPluginSettings', [repoId, branch, pluginId, values, expected], () => {
        const repo = mirror.repositories.find((r) => r.id === repoId)
        const data = { ...(repo.branchData[branch] ?? {}) }
        const next = { ...(data.pluginSettings ?? {}) }
        if (Object.keys(values).length > 0) next[pluginId] = values
        else delete next[pluginId]
        repo.branchData[branch] = { ...data, pluginSettings: next }
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
  return { o: v2SettingsOverrides(writer, requests, () => mirror, listsPlugin), sends, asked, choices, writer, mirror }
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

test("a plugin's repository settings (plugins E3): repo.setPluginSettings with the plugin's values as expected, shown pending; an unknown repository sends nothing", () => {
  const { o, calls, writer, mirror } = setup()
  o.setPluginRepoSettings('env', 'r2', { enabled: true, cpu: 2 }, 'Colima environments')
  o.setPluginRepoSettings('env', 'r1', { enabled: true }, 'Colima environments')
  o.setPluginRepoSettings('other', 'r2', {}, 'Other')
  o.setPluginRepoSettings('env', 'nope', { enabled: true })
  // Clearing what is not there is no change: the writer sends nothing.
  o.setPluginRepoSettings('third', 'r1', {})
  assert.deepEqual(calls, [
    ['setRepoPluginSettings', 'r2', 'env', { enabled: true, cpu: 2 }, { enabled: true, cpu: 4 }],
    ['setRepoPluginSettings', 'r1', 'env', { enabled: true }, null],
    ['setRepoPluginSettings', 'r2', 'other', {}, { on: true }]
  ])
  assert.deepEqual(writer.overlay(mirror).repositories[1].pluginSettings, { env: { enabled: true, cpu: 2 } })
  assert.deepEqual(mirror.repositories[1].pluginSettings.env, { enabled: true, cpu: 4 }, 'the mirror itself is untouched')
  o.setPluginRepoSettings('env', 'r2', {}, 'Colima environments')
  assert.equal('pluginSettings' in writer.overlay(mirror).repositories[1], false, 'emptied, the map goes')
})

test("a plugin's branch settings (plugins E3): branch.setPluginSettings with expected, shown pending; cleared, the emptied entry goes", async () => {
  const { o, sends, writer, mirror } = pendingSetup()
  o.setPluginBranchSettings('env', 'r1', 'feat', { env: 'A=1' }, 'Colima environments')
  assert.deepEqual(sends[0].args, ['r1', 'feat', 'env', { env: 'A=1' }, null])
  assert.deepEqual(writer.overlay(mirror).repositories[0].branchData.feat, { pluginSettings: { env: { env: 'A=1' } } })
  o.setPluginBranchSettings('env', 'r1', 'feat', {}, 'Colima environments')
  assert.equal('feat' in writer.overlay(mirror).repositories[0].branchData, false)
  sends[0].ok()
  await tick()
  assert.deepEqual(sends[1].args, ['r1', 'feat', 'env', {}, { env: 'A=1' }])
})

test("a plugin's setting changed elsewhere meanwhile (plugins E3): another field of it is kept, silently", async () => {
  const { o, sends, asked } = pendingSetup()
  o.setPluginRepoSettings('env', 'r2', { enabled: true, cpu: 4, memory: 16 }, 'Colima environments')
  sends[0].conflict((m) => (m.repositories[1].pluginSettings = { env: { enabled: true, cpu: 8, disk: 100 } }))
  await tick()
  assert.deepEqual(asked, [])
  assert.deepEqual(sends[1].args, ['r2', 'env', { enabled: true, cpu: 8, disk: 100, memory: 16 }, { enabled: true, cpu: 8, disk: 100 }])
})

test("a plugin's setting the other client changed too (plugins E3): asked by the plugin's name; Keep Mine keeps its other fields", async () => {
  const { o, sends, asked, choices } = pendingSetup()
  choices.push('keep')
  o.setPluginRepoSettings('env', 'r2', { enabled: true, cpu: 2 }, 'Colima environments')
  sends[0].conflict((m) => (m.repositories[1].pluginSettings = { env: { enabled: true, cpu: 8, disk: 100 } }))
  await tick()
  await tick()
  assert.deepEqual(asked, ['Colima environments'])
  assert.deepEqual(sends[1].args, ['r2', 'env', { enabled: true, cpu: 2, disk: 100 }, { enabled: true, cpu: 8, disk: 100 }])
})

test('on a server without the env plugin (before plugins E2), the env plugin\'s settings go to the old fields: repo.update\'s environments, branch.setEnv', () => {
  const { o, calls, mirror } = setup({ listsPlugin: () => false })
  mirror.repositories[0].environments = { enabled: false, cpu: 1 }
  mirror.repositories[0].branchData = { main: { env: 'M=1' } }
  o.setPluginRepoSettings('env', 'r2', { enabled: true, cpu: 2 }, 'Colima environments')
  o.setPluginRepoSettings('env', 'r1', {}, 'Colima environments')
  o.setPluginBranchSettings('env', 'r1', 'feat', { env: 'A=1' }, 'Colima environments')
  o.setPluginBranchSettings('env', 'r1', 'main', {}, 'Colima environments')
  assert.deepEqual(calls, [
    ['setEnvironments', 'r2', { enabled: true, cpu: 2 }, { enabled: true, cpu: 4 }],
    ['setEnvironments', 'r1', null, { enabled: false, cpu: 1 }],
    ['setBranchEnv', 'r1', 'feat', 'A=1', null],
    ['setBranchEnv', 'r1', 'main', null, 'M=1']
  ])
  // Another plugin's settings go as they would anywhere.
  const other = setup({ listsPlugin: () => false })
  other.o.setPluginRepoSettings('other', 'r2', { on: false })
  assert.deepEqual(other.calls, [['setRepoPluginSettings', 'r2', 'other', { on: false }, { on: true }]])
})

test('on a server without the env plugin, a set meets a CONFLICT on the old field: re-applied over the other sub-fields, silently', async () => {
  const { o, sends, asked } = pendingSetup({ listsPlugin: () => false })
  o.setPluginRepoSettings('env', 'r2', { enabled: true, cpu: 4, memory: 16 })
  sends[0].conflict((m) => (m.repositories[1].environments = { enabled: true, cpu: 8, disk: 100 }))
  await tick()
  assert.deepEqual(asked, [])
  assert.deepEqual(sends[1].args, ['r2', { enabled: true, cpu: 8, disk: 100, memory: 16 }, { enabled: true, cpu: 8, disk: 100 }])
})

test("expected is exactly the plugin's entry as the window read it (plugins E3): keys the window does not know included; null, never {}, when there is none", () => {
  const { o, calls, mirror } = setup()
  mirror.repositories[1].pluginSettings = { env: { enabled: true, cpu: 4, future: 'x' }, other: { on: true } }
  mirror.repositories[0].branchData = { feat: { note: 'n', pluginSettings: { env: { env: 'A=1', later: [1] } } }, bare: { note: 'b' } }
  o.setPluginRepoSettings('env', 'r2', { enabled: true, cpu: 2, future: 'x' }, 'Colima environments')
  o.setPluginBranchSettings('env', 'r1', 'feat', { env: 'B=2', later: [1] }, 'Colima environments')
  o.setPluginBranchSettings('env', 'r1', 'bare', { env: 'C=3' }, 'Colima environments')
  o.setPluginBranchSettings('env', 'r1', 'nobranch', { env: 'D=4' }, 'Colima environments')
  o.setPluginRepoSettings('third', 'r1', { on: true })
  assert.deepEqual(calls, [
    ['setRepoPluginSettings', 'r2', 'env', { enabled: true, cpu: 2, future: 'x' }, { enabled: true, cpu: 4, future: 'x' }],
    ['setBranchPluginSettings', 'r1', 'feat', 'env', { env: 'B=2', later: [1] }, { env: 'A=1', later: [1] }],
    ['setBranchPluginSettings', 'r1', 'bare', 'env', { env: 'C=3' }, null],
    ['setBranchPluginSettings', 'r1', 'nobranch', 'env', { env: 'D=4' }, null],
    ['setRepoPluginSettings', 'r1', 'third', { on: true }, null]
  ])
})

test("a branch's .env the plugin's copy lacks (over its limit, kept only in the old field) is written through branch.setEnv, guarded by that text (plugins E3)", async () => {
  const { o, sends, writer, mirror } = pendingSetup()
  const big = 'A=' + 'x'.repeat(100_001)
  mirror.repositories[0].branchData = { feat: { env: big, note: 'n' } }
  o.setPluginBranchSettings('env', 'r1', 'feat', { env: 'A=1' }, 'Colima environments')
  assert.equal(sends[0].name, 'setBranchEnv')
  assert.deepEqual(sends[0].args, ['r1', 'feat', 'A=1', big])
  assert.equal(writer.overlay(mirror).repositories[0].branchData.feat.env, 'A=1')
  // Cleared, the old text goes the same way: never a plugin write that would drop it unseen.
  o.setPluginBranchSettings('env', 'r1', 'feat', {}, 'Colima environments')
  sends[0].ok()
  await tick()
  assert.equal(sends[1].name, 'setBranchEnv')
  assert.deepEqual(sends[1].args, ['r1', 'feat', null, 'A=1'])
  // Once the plugin's copy holds the .env (the server mirrors it), the plugin's method again.
  sends[1].ok()
  await tick()
  mirror.repositories[0].branchData.feat = { env: 'E=5', pluginSettings: { env: { env: 'E=5' } } }
  o.setPluginBranchSettings('env', 'r1', 'feat', { env: 'F=6' }, 'Colima environments')
  assert.equal(sends[2].name, 'setBranchPluginSettings')
  assert.deepEqual(sends[2].args, ['r1', 'feat', 'env', { env: 'F=6' }, { env: 'E=5' }])
})
