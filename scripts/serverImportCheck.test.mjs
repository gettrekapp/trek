// scripts/serverImportCheck.test.mjs — what project.import accepts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkImport } from '../server/src/projects/importCheck.ts'
import { PathGuard } from '../server/src/paths.ts'
import { importProjectFile } from '../src/shared/model/importProject.ts'
import { realPath } from '../src/host/pathContainment.ts'
import { removeDir } from './testPlatform.mjs'

function setup(t) {
  // realPath: on Windows the OS's (long names, as the guard resolves paths, not RUNNER~1).
  const dir = realPath(mkdtempSync(join(tmpdir(), 'trek-server-import-')))
  t.after(() => removeDir(dir))
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

test('the permissive guard (the local server) allows a worktree anywhere, but repos must still be registered', (t) => {
  const { registry, project } = setup(t)
  const ctx = { registry, guard: new PathGuard({ repos: registry }, { permissive: true }), existingIds: new Set(), projectId: 'pid' }
  const b = project()
  b.repositories[0].worktrees[1].path = '/elsewhere/wt'
  // Resolved (on Windows: C:\elsewhere\wt).
  assert.equal(checkImport(b, ctx).repositories[0].worktrees[1].path, resolve('/elsewhere/wt'))
  const a = project()
  a.repositories[0].path = '/elsewhere/repo'
  assert.equal(code(() => checkImport(a, ctx)), 'PATH_DENIED')
  const c = project()
  c.repositories[0].worktrees[1].path = registry[0].path
  assert.equal(code(() => checkImport(c, ctx)), 'BAD_REQUEST', 'a worktree at a registered repo is still refused')
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

test('session queues and titles follow the session limits', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  const withSession = (mutate) => { const p = project(); mutate(p.repositories[0].worktrees[1].sessions[0]); return p }
  const globalWith = (mutate) => { const p = project(); mutate(p.globalSessions[0]); return p }
  assert.equal(code(() => checkImport(withSession((s) => { s.queue = Array(101).fill('q') }), ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport(withSession((s) => { s.queue = ['q'.repeat(100_001)] }), ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport(withSession((s) => { s.queue = ['q', ''] }), ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport(globalWith((s) => { s.queue = [''] }), ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport(withSession((s) => { s.title = 'x'.repeat(201) }), ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport(globalWith((s) => { s.title = 'a\u001b[2Jb' }), ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport(withSession((s) => { s.queue = Array(100).fill('q'.repeat(100_000)); s.title = 'x'.repeat(200) }), ctx)), 'ok')
})

test('a nested __proto__ key anywhere in the payload is BAD_REQUEST', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  const p = project()
  p.repositories[0].environments = JSON.parse('{"dev":{"vars":{"__proto__":{"x":1}}}}')
  assert.throws(() => checkImport(p, ctx), (err) => {
    assert.equal(err.code, 'BAD_REQUEST')
    assert.match(err.message, /environments/)
    return true
  })
})

test('two repositories that resolve to the same registered repo are BAD_REQUEST', (t) => {
  const { dir, registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  symlinkSync(join(dir, 'repo'), join(dir, 'repo-link'))
  const a = project()
  const b = project()
  b.repositories[0].path = join(dir, 'repo-link')
  b.repositories[0].worktrees[1].path = join(dir, 'repo-feature2')
  mkdirSync(join(dir, 'repo-feature2'))
  a.repositories.push(b.repositories[0])
  assert.equal(code(() => checkImport(a, ctx)), 'BAD_REQUEST')
})

test('the main worktree takes the registry path', (t) => {
  const { dir, repo, registry, guard, project } = setup(t)
  symlinkSync(repo, join(dir, 'main-link'))
  const p = project()
  p.repositories[0].worktrees[0].path = join(dir, 'main-link')
  const out = checkImport(p, { registry, guard, existingIds: new Set(), projectId: 'pid' })
  assert.equal(out.repositories[0].worktrees[0].path, registry[0].path)
})

test('a non-main worktree path is stored as its realpath', (t) => {
  const { dir, registry, guard, project } = setup(t)
  symlinkSync(join(dir, 'repo-feature'), join(dir, 'feature-link'))
  const p = project()
  p.repositories[0].worktrees[1].path = join(dir, 'feature-link')
  const out = checkImport(p, { registry, guard, existingIds: new Set(), projectId: 'pid' })
  assert.equal(out.repositories[0].worktrees[1].path, join(dir, 'repo-feature'))
})

test('each repository needs exactly one main worktree', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  const none = project()
  none.repositories[0].worktrees[0].isMain = false
  assert.equal(code(() => checkImport(none, ctx)), 'BAD_REQUEST')
  const two = project()
  two.repositories[0].worktrees[1].isMain = true
  assert.equal(code(() => checkImport(two, ctx)), 'BAD_REQUEST')
})

test('a non-main worktree may not be another repository or contain one', (t) => {
  const { dir, registry, guard, project } = setup(t)
  const other = join(dir, 'other')
  mkdirSync(other)
  const twoRepos = [...registry, { id: 'other', name: 'other', path: other }]
  const ctx = { registry: twoRepos, guard: new PathGuard({ repos: twoRepos }), existingIds: new Set(), projectId: 'pid' }
  const a = project()
  a.repositories[0].worktrees[1].path = other
  assert.throws(() => checkImport(a, ctx), (err) => {
    assert.equal(err.code, 'BAD_REQUEST')
    assert.match(err.message, /is another repository/)
    return true
  })
  const b = project()
  b.repositories[0].worktrees[1].path = dir
  assert.equal(code(() => checkImport(b, ctx)), 'BAD_REQUEST')
})

test('a relative non-main worktree path is BAD_REQUEST', (t) => {
  const { registry, guard, project } = setup(t)
  const p = project()
  p.repositories[0].worktrees[1].path = 'repo-feature'
  assert.equal(code(() => checkImport(p, { registry, guard, existingIds: new Set(), projectId: 'new-id' })), 'BAD_REQUEST')
})

test('a worktree path listed twice in one repository is refused', (t) => {
  const { registry, guard, project } = setup(t)
  const p = project()
  const extra = p.repositories[0].worktrees[1]
  p.repositories[0].worktrees.push({ ...extra, id: 'dup-wt', sessions: extra.sessions.map((s, i) => ({ ...s, id: `dup-s${i}` })) })
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  assert.throws(() => checkImport(p, ctx), (e) => e.code === 'BAD_REQUEST' && /listed twice/.test(e.message))
})

test('a worktree branch that git could read as an option is BAD_REQUEST', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  for (const branch of ['--x', '-x', 'a b', 'tab\there', 'nl\nhere', 'del\u007f']) {
    const p = project()
    p.repositories[0].worktrees[1].branch = branch
    assert.equal(code(() => checkImport(p, ctx)), 'BAD_REQUEST', JSON.stringify(branch))
  }
  const ok = project()
  ok.repositories[0].worktrees[1].branch = 'feat/x-1'
  assert.equal(code(() => checkImport(ok, ctx)), 'ok')
})

test("a branch's pull request watch must be an object; what it saw is dropped, so the first poll is a fresh baseline", (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  const p = project()
  p.repositories[0].branchData.feature = { pr: 'https://github.com/acme/app/pull/12', prWatch: { seen: { checks: 'aaa failing', conflict: false, commentsAt: '2099-01-01T00:00:00Z' } } }
  assert.deepEqual(checkImport(p, ctx).repositories[0].branchData.feature, { pr: 'https://github.com/acme/app/pull/12', prWatch: {} })
  for (const bad of [true, 'on', [], null]) {
    const q = project()
    q.repositories[0].branchData.feature = { prWatch: bad }
    assert.equal(code(() => checkImport(q, ctx)), 'BAD_REQUEST', JSON.stringify(bad))
  }
})

test("a session's context is dropped: the automations it names are not imported", (t) => {
  const { registry, guard, project } = setup(t)
  const p = project()
  p.globalSessions[0].context = { kind: 'automation', automationId: 'a1' }
  p.repositories[0].worktrees[1].sessions[0].context = { kind: 'automation', automationId: 'a1' }
  const out = checkImport(p, { registry, guard, existingIds: new Set(), projectId: 'new-id' })
  assert.equal('context' in out.globalSessions[0], false)
  assert.equal('context' in out.repositories[0].worktrees[1].sessions[0], false)
})
