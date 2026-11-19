// scripts/legacyEnvSettings.test.mjs — the Colima plugin's settings under their old names (plugins
// E2): `Repository.environments` and `BranchData.env` mirror `pluginSettings.env` for one release,
// every write writes both, and a project loaded, imported or moved in takes an old field that is
// present as written by an older Trek.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { legacyFromRepoValues, migrateProjectEnv, repoValuesFromLegacy, setBranchEnv, setRepoEnv } from '../server/src/projects/legacyEnv.ts'
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

test("migrateProjectEnv: an old field present wins (an older Trek wrote it); absent, the plugin's value stands and is mirrored", () => {
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
  assert.deepEqual([fresh.environments, fresh.branchData.b.env], [{ enabled: true, cpu: 2 }, 'B=2'])
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
