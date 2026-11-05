// scripts/serverImportCheck.test.mjs — what project.import accepts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkImport } from '../server/src/projects/importCheck.ts'
import { PathGuard } from '../server/src/paths.ts'
import { importProjectFile } from '../src/shared/model/importProject.ts'

function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-import-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  mkdirSync(join(dir, 'repo-feature'))
  const registry = [{ id: 'repo', name: 'repo', path: repo }]
  const guard = new PathGuard({ repos: registry })
  let n = 0
  const project = () => ({
    id: 'ignored', name: 'P', settings: { audioAlerts: true }, globalSessions: [
      { id: `g${++n}`, title: 'G', llm: { provider: 'claude' }, queue: [], status: 'working' }
    ],
    repositories: [{ id: `r${++n}`, name: 'repo', path: repo, branchData: { main: { note: 'n' } }, worktrees: [
      { id: `w${++n}`, name: 'main', path: repo, isMain: true, loaded: true, sessions: [] },
      { id: `w${++n}`, name: 'feature', path: join(dir, 'repo-feature'), isMain: false, loaded: false, branch: 'feature', sessions: [
        { id: `s${++n}`, agentSessionId: 'abc', title: 'S', llm: { provider: 'claude' }, queue: ['q'], status: 'attention', ptyId: 'x' }
      ] }
    ] }]
  })
  return { dir, repo, registry, guard, project }
}

const code = (fn) => {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return 'ok'
}

test('a valid import gets the new id, keeps nested ids and resets runtime state', (t) => {
  const { registry, guard, project } = setup(t)
  const p = project()
  const out = checkImport(p, { registry, guard, existingIds: new Set(), projectId: 'new-id' })
  assert.equal(out.id, 'new-id')
  assert.equal(out.repositories[0].id, p.repositories[0].id)
  const wt = out.repositories[0].worktrees[1]
  assert.equal(wt.sessions[0].status, 'idle')
  assert.equal(wt.sessions[0].ptyId, undefined)
  assert.equal(wt.sessions[0].agentSessionId, 'abc')
  assert.equal(out.repositories[0].worktrees[0].loaded, false)
  assert.equal(out.globalSessions[0].status, 'idle')
})

test('the output of importProjectFile is accepted', (t) => {
  const { repo, registry, guard } = setup(t)
  let n = 0
  const { projects } = importProjectFile({
    version: 3, name: 'File', repositories: [{ id: 'old', name: 'repo', path: repo, worktrees: [{ name: 'main', path: repo }] }]
  }, () => `id-${++n}`)
  const out = checkImport(projects[0].project, { registry, guard, existingIds: new Set(), projectId: 'pid' })
  assert.equal(out.name, 'File')
})

test('ids must be non-empty, space-free, unique in the project and new on the server', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  const withId = (mutate) => { const p = project(); mutate(p); return p }
  assert.equal(code(() => checkImport(withId((p) => { p.repositories[0].id = '' }), ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport(withId((p) => { p.repositories[0].id = 'a b' }), ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport(withId((p) => { p.repositories[0].worktrees[1].id = p.repositories[0].worktrees[0].id }), ctx)), 'BAD_REQUEST')
  const p = project()
  assert.equal(code(() => checkImport(p, { ...ctx, existingIds: new Set([p.globalSessions[0].id]) })), 'BAD_REQUEST')
})

test('repository paths must be registered; worktree paths must be allowed', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  const a = project()
  a.repositories[0].path = '/elsewhere/repo'
  assert.equal(code(() => checkImport(a, ctx)), 'PATH_DENIED')
  const b = project()
  b.repositories[0].worktrees[1].path = '/elsewhere/wt'
  assert.equal(code(() => checkImport(b, ctx)), 'PATH_DENIED')
})

test('shape, settings and branch keys are checked', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  assert.equal(code(() => checkImport(null, ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport({ ...project(), repositories: [] }, ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport({ ...project(), name: ' ' }, ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport({ ...project(), settings: { nope: 1 } }, ctx)), 'BAD_REQUEST')
  const p = project()
  p.repositories[0].branchData = JSON.parse('{"__proto__": {"note": "x"}}')
  assert.equal(code(() => checkImport(p, ctx)), 'BAD_REQUEST')
  const q = project()
  q.repositories[0].worktrees[1].sessions[0].queue = [1]
  assert.equal(code(() => checkImport(q, ctx)), 'BAD_REQUEST')
})
