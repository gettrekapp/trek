// scripts/serverPromote.test.mjs — worktree.promote, worktree.demote and promote.answer (phase 5e),
// against real git in a temp dir and a session manager with a fake pty spawner (promoteFixture.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectDir } from '../src/host/claudeSessionService.ts'
import { promoteChanging } from '../server/src/promote/promoteHandlers.ts'
import { CLAUDE_ID, MAIN_ID, branchOf, git, setup, status } from './promoteFixture.mjs'

test('worktree.promote dryRun: the plan, nothing changed', async (t) => {
  const s = await setup(t)
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId, dryRun: true })
  assert.equal(r.ok, true, JSON.stringify(r))
  const plan = r.result
  assert.equal(plan.branch, 'feat')
  assert.equal(plan.mainPath, s.app)
  assert.equal(plan.worktreePath, s.path)
  assert.equal(plan.mainBranch, 'main')
  assert.equal(plan.dirty, true)
  assert.deepEqual(plan.sessions.map((x) => [x.title, x.carried]), [['Claude 1', true], ['Codex 1', false]])
  assert.match(plan.sessions[1].reason, /closed/)
  assert.equal(plan.reviewComments, 1)
  assert.equal(plan.reviewCarried, true)
  assert.deepEqual(plan.ignored, ['ignored/'])
  assert.equal(branchOf(s.app), 'main')
  assert.ok(existsSync(s.path))
})

test('worktree.promote: the main checkout has the branch and its work, the worktree is gone, sessions and history moved', async (t) => {
  const s = await setup(t)
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.result.worktreeId, s.mainId)
  assert.deepEqual(r.result.moved, [CLAUDE_ID])
  assert.ok(r.result.notes.some((n) => /Codex 1/.test(n)))
  assert.equal(branchOf(s.app), 'feat')
  assert.deepEqual(status(s.app), [' M README', '?? staged.txt', '?? untracked.txt'])
  assert.equal(readFileSync(join(s.app, 'feat.txt'), 'utf8'), 'committed\n')
  assert.ok(!existsSync(s.path))
  const rows = s.repo().worktrees
  assert.deepEqual(rows.map((w) => w.id), [s.mainId])
  const main = rows[0]
  assert.deepEqual(main.sessions.map((x) => x.id), [MAIN_ID, CLAUDE_ID])
  assert.deepEqual(main.sessions[1].queue, ['later'])
  assert.equal(main.review.comments.length, 1)
  assert.ok(main.review.revision > 3)
  assert.ok(existsSync(join(projectDir(s.app), `${CLAUDE_ID}.jsonl`)))
  assert.ok(!existsSync(join(projectDir(s.path), `${CLAUDE_ID}.jsonl`)))
  assert.equal(s.repo().branchData.feat.note, 'the note')
})

test('worktree.promote: a loaded worktree is stopped and its sessions resume in the main checkout', async (t) => {
  const s = await setup(t)
  assert.equal((await s.call('worktree.load', { projectId: s.projectId, worktreeId: s.worktreeId })).ok, true)
  const before = s.spawned.length
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, true, JSON.stringify(r))
  // The main checkout was not loaded: loading it resumes its own session and the moved one.
  const main = s.repo().worktrees[0]
  assert.equal(main.loaded, true)
  assert.ok(main.sessions.every((x) => x.ptyId))
  const resumed = s.spawned.slice(before)
  assert.equal(resumed.length, 2)
  assert.ok(resumed.every((p) => p.opts.cwd === s.app))
})

test('worktree.promote refuses a main checkout with uncommitted changes, and changes nothing', async (t) => {
  const s = await setup(t)
  writeFileSync(join(s.app, 'README'), 'dirty main\n')
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'CONFLICT')
  assert.match(r.error.message, /main checkout/)
  assert.equal(branchOf(s.app), 'main')
  assert.ok(existsSync(s.path))
})

test('worktree.promote refuses the main checkout itself', async (t) => {
  const s = await setup(t)
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.mainId })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'BAD_REQUEST')
})

test('worktree.promote puts everything back when the worktree cannot be removed (a locked worktree)', async (t) => {
  const s = await setup(t)
  git(s.app, 'worktree', 'lock', s.path)
  const before = status(s.path)
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.error.code, 'GIT_ERROR')
  assert.equal(branchOf(s.app), 'main')
  assert.deepEqual(status(s.app), [])
  assert.ok(existsSync(s.path))
  assert.deepEqual(status(s.path), before)
  assert.equal(s.repo().worktrees.length, 2)
  assert.ok(existsSync(join(projectDir(s.path), `${CLAUDE_ID}.jsonl`)))
})

test('worktree.promote refuses while another promote changes the repository', async (t) => {
  const s = await setup(t)
  promoteChanging.add(realpathSync(s.app))
  t.after(() => promoteChanging.clear())
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'CONFLICT')
  assert.ok(existsSync(s.path))
})

/** After a promote: the main checkout on feat, with work and the moved sessions. */
async function promoted(t) {
  const s = await setup(t)
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, true, JSON.stringify(r))
  // A codex session in the main checkout too: it stays there on a demote.
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[0].sessions.push({ id: 'codex-main', title: 'Codex main', llm: { provider: 'codex' }, queue: [], status: 'idle' })
  })
  git(s.app, 'add', 'staged.txt')
  return s
}

test('worktree.demote: the branch and its work go to a new worktree, the main checkout back on main and clean', async (t) => {
  const s = await promoted(t)
  const plan = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId, dryRun: true })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  assert.equal(plan.result.branch, 'feat')
  assert.equal(plan.result.mainBranch, 'main')
  assert.equal(plan.result.worktreePath, s.path)
  assert.deepEqual(plan.result.sessions.map((x) => [x.title, x.carried]), [['Main Claude', true], ['Claude 1', true], ['Codex main', false]])
  const r = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(branchOf(s.app), 'main')
  assert.deepEqual(status(s.app), [])
  assert.equal(branchOf(s.path), 'feat')
  assert.deepEqual(status(s.path), [' M README', '?? staged.txt', '?? untracked.txt'])
  const rows = s.repo().worktrees
  const created = rows.find((w) => w.id === r.result.worktreeId)
  assert.ok(created && !created.isMain)
  assert.deepEqual(created.sessions.map((x) => x.id).sort(), [CLAUDE_ID, MAIN_ID].sort())
  assert.deepEqual(rows.find((w) => w.isMain).sessions.map((x) => x.id), ['codex-main'])
  assert.equal(created.review.comments.length, 1)
  assert.equal(rows.find((w) => w.isMain).review, undefined)
  assert.ok(existsSync(join(projectDir(s.path), `${MAIN_ID}.jsonl`)) || !existsSync(join(projectDir(s.app), `${MAIN_ID}.jsonl`)))
  assert.ok(existsSync(join(projectDir(s.path), `${CLAUDE_ID}.jsonl`)))
})

test('worktree.demote refuses on the default branch, and when the worktree path exists', async (t) => {
  const s = await setup(t)
  const onMain = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
  assert.equal(onMain.ok, false)
  assert.equal(onMain.error.code, 'BAD_REQUEST')
  assert.match(onMain.error.message, /already on main/)
  const p = await promoted(t)
  mkdirSync(p.path)
  const taken = await p.call('worktree.demote', { projectId: p.projectId, repoId: p.repoId })
  assert.equal(taken.ok, false)
  assert.equal(taken.error.code, 'CONFLICT')
  assert.equal(branchOf(p.app), 'feat')
})

test('worktree.demote puts everything back when the main checkout cannot switch back to main', async (t) => {
  const s = await promoted(t)
  // main (not checked out anywhere now) gets a tracked shared/x; the main checkout, on feat, has an
  // untracked shared/x in a linked folder (shared from the main checkout, not carried), which the
  // switch to main would overwrite: git refuses it.
  const side = join(s.dir, 'side')
  git(s.app, 'worktree', 'add', '-q', side, 'main')
  mkdirSync(join(side, 'shared'))
  writeFileSync(join(side, 'shared', 'x'), 'tracked on main\n')
  git(side, 'add', '.')
  git(side, 'commit', '-q', '-m', 'shared')
  git(s.app, 'worktree', 'remove', side)
  await s.poller.refresh(s.app)
  s.projects.apply(s.projectId, (d) => { d.repositories[0].linkedDirs = ['shared'] })
  mkdirSync(join(s.app, 'shared'))
  writeFileSync(join(s.app, 'shared', 'x'), 'local\n')
  const before = status(s.app)
  const r = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.error.code, 'GIT_ERROR')
  assert.equal(branchOf(s.app), 'feat')
  assert.deepEqual(status(s.app), before)
  assert.equal(readFileSync(join(s.app, 'shared', 'x'), 'utf8'), 'local\n')
  assert.ok(!existsSync(s.path))
  assert.equal(s.repo().worktrees.filter((w) => !w.missing).length, 1)
  assert.equal(s.repo().worktrees.find((w) => w.isMain).sessions.length, 3)
})

test('promote.answer: an unknown request is not accepted', async (t) => {
  const s = await setup(t)
  const r = await s.call('promote.answer', { projectId: s.projectId, requestId: 'nope', outcome: 'declined' })
  assert.deepEqual(r, { ok: true, result: { accepted: false } })
  const badOutcome = await s.call('promote.answer', { projectId: s.projectId, requestId: 'nope', outcome: 'maybe' })
  assert.equal(badOutcome.ok, false)
})

