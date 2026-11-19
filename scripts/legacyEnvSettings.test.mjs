// scripts/legacyEnvSettings.test.mjs — the Colima plugin's settings under their old names (plugins
// E2): `Repository.environments` and `BranchData.env` mirror `pluginSettings.env` for one release,
// every write writes both, and a project loaded, imported or moved in takes an old field that is
// present as written by an older Trek.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEGACY_ENV_BRANCH_FIELD, LEGACY_ENV_PLUGIN, LEGACY_ENV_REPO_FIELDS, legacyFromRepoValues, migrateBranchEnv, migrateProjectEnv, repoValuesFromLegacy, setBranchEnv, setRepoEnv } from '../server/src/projects/legacyEnv.ts'
import { COLIMA_MANIFEST } from '../plugins/colima/manifest.ts'
import { isUsablePluginId, pluginFieldsProblem } from '../src/shared/plugins/manifest.ts'
import { ProjectStore, STORE_SCHEMA } from '../server/src/projects/store.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { removeDir } from './testPlatform.mjs'

const repoWith = (more = {}) => ({ id: 'r1', name: 'app', path: '/r/app', branchData: {}, worktrees: [], ...more })

test("the old environments object maps to the plugin's values (its known fields, each of the right kind), and back with enabled always there", () => {
  assert.deepEqual(
    repoValuesFromLegacy({ enabled: true, cpu: 3, memory: 1.5, composeFile: 'a.yml,b.yml', profileKey: '/old/a', extra: 1, disk: '20', rosetta: 'yes' }),
    { enabled: true, cpu: 3, memory: 1.5, composeFile: 'a.yml,b.yml', profileKey: '/old/a' }
  )
  for (const bad of [undefined, null, 'x', [true]]) assert.deepEqual(repoValuesFromLegacy(bad), {})
  assert.deepEqual(legacyFromRepoValues({ cpu: 2 }), { enabled: false, cpu: 2 })
  assert.deepEqual(legacyFromRepoValues({ enabled: true }), { enabled: true })
  assert.equal(legacyFromRepoValues({}), undefined)
  assert.equal(legacyFromRepoValues(undefined), undefined)
})

test("setRepoEnv and setBranchEnv write the plugin's values and the mirror together; none clears both; other plugins' are kept", () => {
  const repo = repoWith({ pluginSettings: { other: { on: true } } })
  setRepoEnv(repo, { enabled: true, cpu: 4 })
  assert.deepEqual([repo.pluginSettings, repo.environments], [{ other: { on: true }, env: { enabled: true, cpu: 4 } }, { enabled: true, cpu: 4 }])
  setRepoEnv(repo, {})
  assert.deepEqual([repo.pluginSettings, repo.environments], [{ other: { on: true } }, undefined])
  const data = { note: 'n', pluginSettings: { env: { keep: true } } }
  setBranchEnv(data, 'A=1\n')
  assert.deepEqual(data, { note: 'n', env: 'A=1\n', pluginSettings: { env: { keep: true, env: 'A=1\n' } } })
  setBranchEnv(data, null)
  assert.deepEqual(data, { note: 'n', pluginSettings: { env: { keep: true } } })
  const bare = {}
  setBranchEnv(bare, 'A=1')
  setBranchEnv(bare, null)
  assert.deepEqual(bare, {})
})

test("migrateProjectEnv: an old field present wins (an older Trek wrote it); absent, an older Trek cleared it, so the plugin's copy goes", () => {
  const project = {
    id: 'p', name: 'P', settings: {}, globalSessions: [],
    repositories: [
      repoWith({ id: 'old', environments: { enabled: true, profileKey: '/old/a' }, branchData: { b: { env: 'A=1' }, c: { note: 'x' } } }),
      repoWith({ id: 'new', pluginSettings: { env: { enabled: true, cpu: 2 } }, branchData: { b: { pluginSettings: { env: { env: 'B=2' } } } } }),
      repoWith({
        id: 'both',
        environments: { enabled: false },
        pluginSettings: { env: { enabled: true } },
        branchData: { b: { env: 'OLD=1', pluginSettings: { env: { env: 'NEW=1' } } }, huge: { env: 'x'.repeat(100_001) } }
      })
    ]
  }
  const [old, fresh, both] = migrateProjectEnv(project).repositories
  assert.deepEqual([old.pluginSettings, old.environments], [{ env: { enabled: true, profileKey: '/old/a' } }, { enabled: true, profileKey: '/old/a' }])
  assert.deepEqual(old.branchData, { b: { env: 'A=1', pluginSettings: { env: { env: 'A=1' } } }, c: { note: 'x' } })
  assert.deepEqual([fresh.pluginSettings, fresh.environments, fresh.branchData], [undefined, undefined, {}], 'cleared; the emptied branch entry goes')
  assert.deepEqual([both.pluginSettings.env, both.environments, both.branchData.b.pluginSettings.env.env, both.branchData.b.env], [{ enabled: false }, { enabled: false }, 'OLD=1', 'OLD=1'])
  assert.deepEqual([both.branchData.huge.env.length, both.branchData.huge.pluginSettings], [100_001, undefined], 'past the text limit: kept as it was, not mirrored')
})

test("a project file from before E2 loads with its environments and .env in the plugin's settings, the old fields kept as the mirror", (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-legacy-env-'))
  t.after(() => removeDir(dir))
  const project = {
    id: 'p1', name: 'P', settings: {}, globalSessions: [],
    repositories: [repoWith({ environments: { enabled: true, cpu: 3 }, branchData: { feat: { env: 'FOO=bar' } }, worktrees: [{ id: 'w1', name: 'app', path: '/r/app', isMain: true, loaded: false, sessions: [] }] })]
  }
  writeFileSync(join(dir, 'p1.json'), JSON.stringify({ schema: STORE_SCHEMA, project }))
  const [loaded] = new ProjectStore(dir).loadAll()
  assert.deepEqual(loaded.repositories[0].pluginSettings, { env: { enabled: true, cpu: 3 } })
  assert.deepEqual(loaded.repositories[0].environments, { enabled: true, cpu: 3 })
  assert.deepEqual(loaded.repositories[0].branchData.feat, { env: 'FOO=bar', pluginSettings: { env: { env: 'FOO=bar' } } })
})

/** A stand-in for the registry: the env plugin's fields, as its manifest declares them. */
const envFields = {
  settingFields: (id, scope) =>
    id !== 'env' ? undefined : scope === 'repo'
      ? { enabled: 'boolean', cpu: 'number', memory: 'number', disk: 'number', networkAddress: 'boolean', rosetta: 'boolean', composeFile: 'string', profileKey: 'string' }
      : { env: 'text' }
}

test("an older client's repo.update {environments} and branch.setEnv write the plugin's settings too; the plugin's own calls write the old fields", async () => {
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'app', path: '/r/app' }, name: undefined }])
  const repoId = projects.require(projectId).repositories[0].id
  const repo = () => projects.require(projectId).repositories[0]
  const call = (method, params) => dispatchV2(method, { projectId, repoId, ...params }, { projects, hub, plugins: envFields })
  assert.equal((await call('repo.update', { environments: { enabled: true, cpu: 3, bogus: 1 }, expected: { environments: null } })).ok, true)
  assert.deepEqual([repo().pluginSettings, repo().environments], [{ env: { enabled: true, cpu: 3 } }, { enabled: true, cpu: 3 }])
  assert.equal((await call('repo.update', { environments: { enabled: false, cpu: 3 }, expected: { environments: { enabled: true, cpu: 3 } } })).ok, true, 'expected is compared with the mirror')
  assert.equal((await call('repo.update', { environments: { enabled: true }, expected: { environments: { enabled: true, cpu: 3 } } })).error?.code, 'CONFLICT')
  assert.equal((await call('branch.setEnv', { branch: 'feat', env: 'FOO=bar', expected: null })).ok, true)
  assert.deepEqual(repo().branchData.feat, { env: 'FOO=bar', pluginSettings: { env: { env: 'FOO=bar' } } })
  assert.equal((await call('branch.setEnv', { branch: 'feat', env: 'BAZ=1', expected: 'other' })).error?.code, 'CONFLICT')
  assert.equal((await call('branch.setEnv', { branch: 'feat', env: 'x'.repeat(100_001) })).error?.code, 'BAD_REQUEST')
  assert.equal((await call('branch.setEnv', { branch: 'feat', env: null })).ok, true)
  assert.equal(repo().branchData.feat, undefined, 'an emptied branch entry goes')
  assert.equal((await call('repo.setPluginSettings', { pluginId: 'env', values: { enabled: true, memory: 6 } })).ok, true)
  assert.deepEqual(repo().environments, { enabled: true, memory: 6 })
  assert.equal((await call('branch.setPluginSettings', { branch: 'feat', pluginId: 'env', values: { env: 'A=1' } })).ok, true)
  assert.equal(repo().branchData.feat.env, 'A=1')
  assert.equal((await call('branch.setPluginSettings', { branch: 'feat', pluginId: 'env', values: {} })).ok, true)
  assert.equal(repo().branchData.feat, undefined)
  assert.equal((await call('repo.update', { environments: null })).ok, true)
  assert.deepEqual([repo().pluginSettings, repo().environments], [undefined, undefined])
})

test("the old fields' writes keep the plugin settings' caps: past 1 MB in all is BAD_REQUEST and nothing is kept", async () => {
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'app', path: '/r/app' }, name: undefined }])
  const kept = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 'x'.repeat(100_000)]))
  projects.apply(projectId, (d) => {
    d.repositories[0].branchData.feat = { note: 'n', pluginSettings: { kept } }
  })
  const repoId = projects.require(projectId).repositories[0].id
  const call = (method, params) => dispatchV2(method, { projectId, repoId, ...params }, { projects, hub, plugins: envFields })
  const out = await call('branch.setEnv', { branch: 'feat', env: 'y'.repeat(60_000) })
  assert.equal(out.error?.code, 'BAD_REQUEST')
  assert.match(out.error.message, /1 MB/)
  assert.deepEqual(projects.require(projectId).repositories[0].branchData.feat, { note: 'n', pluginSettings: { kept } })
})

test("migrateProjectEnv keeps the plugin's values the old field cannot hold, leaves a malformed map alone, and reports a map it would push past the caps", () => {
  const problems = []
  const kept = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 'x'.repeat(100_000)]))
  const project = {
    id: 'p', name: 'P', settings: {}, globalSessions: [],
    repositories: [
      repoWith({ id: 'a', environments: { enabled: true }, pluginSettings: { env: { cpu: 2, later: 'kept' } } }),
      repoWith({ id: 'b', environments: { enabled: true }, pluginSettings: 'garbage', branchData: { big: { env: 'y'.repeat(60_000), pluginSettings: { kept } } } })
    ]
  }
  const [a, b] = migrateProjectEnv(project, (where, problem) => problems.push([where, problem])).repositories
  assert.deepEqual([a.pluginSettings, a.environments], [{ env: { later: 'kept', enabled: true } }, { enabled: true }])
  assert.deepEqual([b.pluginSettings, b.environments], ['garbage', { enabled: true }], 'left as it was')
  assert.deepEqual(b.branchData.big, { env: 'y'.repeat(60_000), pluginSettings: { kept } }, 'left as it was')
  assert.equal(problems.length, 2)
  assert.match(problems[1][0], /branchData\["big"\]/)
  assert.match(problems[1][1], /1 MB/)
})

/** A store in a temp dir with one project file. */
function storeWith(t, project) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-legacy-env-'))
  t.after(() => removeDir(dir))
  writeFileSync(join(dir, `${project.id}.json`), JSON.stringify({ schema: STORE_SCHEMA, project }))
  return { dir, store: new ProjectStore(dir) }
}
const mainWorktree = [{ id: 'w1', name: 'app', path: '/r/app', isMain: true, loaded: false, sessions: [] }]

test("a rolled-back server cleared the .env and environments: on load the plugin's copies stay cleared, plugin-only keys kept", (t) => {
  const project = {
    id: 'p1', name: 'P', settings: {}, globalSessions: [],
    repositories: [repoWith({
      pluginSettings: { env: { enabled: true, cpu: 2, later: 'x' }, other: { on: true } },
      branchData: { feat: { pluginSettings: { env: { env: 'SECRET=1' } } }, kept: { note: 'n', pluginSettings: { env: { env: 'SECRET=2' } } } },
      worktrees: mainWorktree
    })]
  }
  const [loaded] = storeWith(t, project).store.loadAll()
  const repo = loaded.repositories[0]
  assert.deepEqual([repo.pluginSettings, repo.environments], [{ env: { later: 'x' }, other: { on: true } }, undefined])
  assert.deepEqual(repo.branchData, { kept: { note: 'n' } })
})

test("envFieldsRetired (E3's switch): a plugin copy without the old field stands and is mirrored", (t) => {
  const project = {
    id: 'p1', name: 'P', settings: {}, globalSessions: [], envFieldsRetired: true,
    repositories: [repoWith({ pluginSettings: { env: { enabled: true, cpu: 2 } }, branchData: { feat: { pluginSettings: { env: { env: 'A=1' } } } }, worktrees: mainWorktree })]
  }
  const [loaded] = storeWith(t, project).store.loadAll()
  const repo = loaded.repositories[0]
  assert.deepEqual([repo.pluginSettings, repo.environments], [{ env: { enabled: true, cpu: 2 } }, { enabled: true, cpu: 2 }])
  assert.deepEqual(repo.branchData.feat, { pluginSettings: { env: { env: 'A=1' } }, env: 'A=1' })
})

test("an old .env past the plugin's limit with a plugin copy: the copy goes, the .env is kept", () => {
  const data = { env: 'x'.repeat(100_001), pluginSettings: { env: { env: 'OLD=1' }, other: { a: 1 } } }
  assert.equal(migrateBranchEnv(data), null)
  assert.deepEqual([data.env.length, data.pluginSettings], [100_001, { other: { a: 1 } }])
})

test("a load problem is logged as project <id>: <problem>", (t) => {
  const kept = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 'x'.repeat(100_000)]))
  const project = {
    id: 'p1', name: 'P', settings: {}, globalSessions: [],
    repositories: [repoWith({ branchData: { big: { env: 'y'.repeat(60_000), pluginSettings: { kept } } }, worktrees: mainWorktree })]
  }
  const { store } = storeWith(t, project)
  const warned = []
  t.mock.method(console, 'warn', (m) => warned.push(String(m)))
  store.loadAll()
  assert.ok(warned.some((m) => /project p1: repositories\[0\]\.branchData\["big"\]\.pluginSettings holds more than 1 MB/.test(m)), warned.join('\n'))
})

test("a save and a load write both copies to disk and read them back in step", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-legacy-env-'))
  t.after(() => removeDir(dir))
  const store = new ProjectStore(dir)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store, onSummariesChange: () => {} })
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'app', path: '/r/app' }, name: undefined }])
  const repoId = projects.require(projectId).repositories[0].id
  const call = (method, params) => dispatchV2(method, { projectId, repoId, ...params }, { projects, hub, plugins: envFields })
  assert.equal((await call('repo.update', { environments: { enabled: true, cpu: 3 } })).ok, true)
  assert.equal((await call('branch.setEnv', { branch: 'feat', env: 'FOO=bar' })).ok, true)
  store.flush()
  const onDisk = JSON.parse(readFileSync(join(dir, `${projectId}.json`), 'utf8')).project.repositories[0]
  assert.deepEqual([onDisk.environments, onDisk.pluginSettings, onDisk.branchData.feat], [
    { enabled: true, cpu: 3 }, { env: { enabled: true, cpu: 3 } }, { env: 'FOO=bar', pluginSettings: { env: { env: 'FOO=bar' } } }
  ])
  const [loaded] = new ProjectStore(dir).loadAll()
  assert.deepEqual([loaded.repositories[0].environments, loaded.repositories[0].pluginSettings, loaded.repositories[0].branchData.feat], [
    onDisk.environments, onDisk.pluginSettings, onDisk.branchData.feat
  ])
})

test("repo.update {environments} keeps a stored plugin-only key, and environments: null does too", async () => {
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'app', path: '/r/app' }, name: undefined }])
  projects.apply(projectId, (d) => {
    d.repositories[0].pluginSettings = { env: { enabled: false, cpu: 2, later: 'x' } }
    d.repositories[0].environments = { enabled: false, cpu: 2 }
  })
  const repo = () => projects.require(projectId).repositories[0]
  const call = (method, params) => dispatchV2(method, { projectId, repoId: repo().id, ...params }, { projects, hub, plugins: envFields })
  assert.equal((await call('repo.update', { environments: { enabled: true } })).ok, true)
  assert.deepEqual([repo().pluginSettings, repo().environments], [{ env: { later: 'x', enabled: true } }, { enabled: true }])
  assert.equal((await call('repo.update', { environments: null })).ok, true)
  assert.deepEqual([repo().pluginSettings, repo().environments], [{ env: { later: 'x' } }, undefined])
})

test("repo.update reads a corrupt (non-object) env plugin entry as none", async () => {
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'app', path: '/r/app' }, name: undefined }])
  projects.apply(projectId, (d) => {
    d.repositories[0].pluginSettings = { env: 'corrupt' }
  })
  const repo = () => projects.require(projectId).repositories[0]
  const out = await dispatchV2('repo.update', { projectId, repoId: repo().id, environments: { enabled: true } }, { projects, hub, plugins: envFields })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual([repo().pluginSettings, repo().environments], [{ env: { enabled: true } }, { enabled: true }])
})

test("the old fields are the Colima plugin's settings, kind for kind (the mirror must not drift from the manifest)", () => {
  assert.equal(COLIMA_MANIFEST.id, LEGACY_ENV_PLUGIN)
  assert.deepEqual(COLIMA_MANIFEST.repoSettings, LEGACY_ENV_REPO_FIELDS)
  assert.deepEqual(COLIMA_MANIFEST.branchSettings, { [LEGACY_ENV_BRANCH_FIELD]: 'text' })
  assert.deepEqual([COLIMA_MANIFEST.platforms, COLIMA_MANIFEST.legacyCapability, COLIMA_MANIFEST.legacyBuiltIn, COLIMA_MANIFEST.defaultEnabled], [['darwin', 'linux'], ['env'], true, true])
  // And the registry would take the manifest (its id and field declarations; it registers in Task 8).
  assert.ok(isUsablePluginId(COLIMA_MANIFEST.id))
  assert.equal(pluginFieldsProblem(COLIMA_MANIFEST.repoSettings), null)
  assert.equal(pluginFieldsProblem(COLIMA_MANIFEST.branchSettings), null)
})
