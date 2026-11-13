// scripts/serverPromote.test.mjs — worktree.promote, worktree.demote and promote.answer (phase 5e),
// against real git in a temp dir and a session manager with a fake pty spawner (promoteFixture.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectDir } from '../src/host/claudeSessionService.ts'
import { promoteChanging, promoteTestHooks, pruneRecoveryFiles } from '../server/src/promote/promoteHandlers.ts'
import { CLAUDE_ID, MAIN_ID, branchOf, git, setup, status } from './promoteFixture.mjs'
import { realPath } from '../src/host/pathContainment.ts'
import { posixOnly } from './testPlatform.mjs'

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
  // Claude's folder of subagent transcripts and tool results moves with the history.
  assert.ok(existsSync(join(projectDir(s.app), CLAUDE_ID, 'subagents', 'agent-1.jsonl')))
  assert.ok(!existsSync(join(projectDir(s.path), CLAUDE_ID)))
  assert.equal(s.repo().branchData.feat.note, 'the note')
  // The copy of the work saved before the switch is gone once all went well.
  assert.deepEqual(existsSync(s.recoveryDir) ? readdirSync(s.recoveryDir) : [], [])
  assert.equal(r.result.recoveryFile, undefined)
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

test('worktree.promote refuses a locked worktree, and changes nothing', async (t) => {
  const s = await setup(t)
  git(s.app, 'worktree', 'lock', s.path)
  const before = status(s.path)
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.error.code, 'CONFLICT')
  assert.match(r.error.message, /locked/)
  assert.equal(branchOf(s.app), 'main')
  assert.deepEqual(status(s.app), [])
  assert.deepEqual(status(s.path), before)
  assert.equal(s.repo().worktrees.length, 2)
})

// chmod 0555 makes a folder undeletable on POSIX only (Windows' read-only bit is not honoured on folders).
test('worktree.promote: a worktree folder that cannot be fully removed is a note after the commitment, nothing lost', { skip: posixOnly('a read-only directory (chmod)') }, async (t) => {
  const s = await setup(t)
  const locked = join(s.path, 'readonly')
  mkdirSync(locked)
  writeFileSync(join(locked, 'kept.txt'), 'kept\n')
  chmodSync(locked, 0o555)
  let r
  try {
    r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  } finally {
    // Before the fixture's cleanup removes the temp dir.
    chmodSync(locked, 0o755)
  }
  assert.equal(r.ok, true, JSON.stringify(r))
  // The main checkout has the branch and all of the work, the folder's file included.
  assert.equal(branchOf(s.app), 'feat')
  assert.deepEqual(status(s.app), [' M README', '?? readonly/', '?? staged.txt', '?? untracked.txt'])
  assert.equal(readFileSync(join(s.app, 'readonly', 'kept.txt'), 'utf8'), 'kept\n')
  const note = r.result.notes.find((n) => /could not be fully removed/.test(n))
  assert.ok(note, JSON.stringify(r.result.notes))
  assert.match(note, /remove it yourself/)
  // The records moved anyway, and the copy of the work is kept, 0600, named in the note.
  assert.deepEqual(s.repo().worktrees.filter((w) => w.id === s.worktreeId), [])
  assert.deepEqual(s.repo().worktrees.find((w) => w.isMain).sessions.map((x) => x.id), [MAIN_ID, CLAUDE_ID])
  assert.ok(r.result.recoveryFile && note.includes(r.result.recoveryFile))
  assert.ok(r.result.recoveryFile.startsWith(s.recoveryDir))
  assert.equal(statSync(r.result.recoveryFile).mode & 0o777, 0o600)
  assert.match(readFileSync(r.result.recoveryFile, 'utf8'), /kept/)
})

test('worktree.promote: a session.start racing the in-lock check is refused; nothing runs in the removed worktree', async (t) => {
  const s = await setup(t)
  const refresh = s.poller.refresh.bind(s.poller)
  let calls = 0
  const raced = []
  s.poller.refresh = async (...args) => {
    calls += 1
    // The second check's re-read (inside the lock), and the re-read after the commitment: a
    // window starts a session in the worktree meanwhile.
    if (calls === 2 || calls === 3) raced.push(await s.call('session.start', { projectId: s.projectId, worktreeId: s.worktreeId, cols: 80, rows: 24 }))
    return refresh(...args)
  }
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(raced.length, 2, 'the races ran')
  for (const x of raced) {
    assert.equal(x.ok, false, JSON.stringify(x))
    assert.equal(x.error.code, 'IN_USE')
  }
  assert.ok(s.spawned.filter((p) => p.opts.cwd === s.path).every((p) => p.killed))
})

test('worktree.promote waits for its stopped agents to exit before packing the work', async (t) => {
  const s = await setup(t)
  assert.equal((await s.call('worktree.load', { projectId: s.projectId, worktreeId: s.worktreeId })).ok, true)
  // An agent that writes one last file as it is stopped, 150 ms after the signal.
  for (const proc of s.spawned.filter((p) => p.opts.cwd === s.path)) {
    proc.kill = function () {
      this.killed = true
      setTimeout(() => {
        writeFileSync(join(s.path, 'last-words.txt'), 'bye\n')
        this.exitCb(129)
      }, 150)
    }
  }
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(readFileSync(join(s.app, 'last-words.txt'), 'utf8'), 'bye\n')
})

test('worktree.promote: the worktree changing after it was packed fails it, and everything is put back', async (t) => {
  const s = await setup(t)
  promoteTestHooks.afterApply = () => writeFileSync(join(s.path, 'late.txt'), 'late\n')
  t.after(() => { delete promoteTestHooks.afterApply })
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.error.code, 'CONFLICT')
  assert.match(r.error.message, /changed while the promote ran/)
  assert.equal(branchOf(s.app), 'main')
  assert.deepEqual(status(s.app), [])
  assert.ok(existsSync(join(s.path, 'late.txt')))
  assert.equal(s.repo().worktrees.length, 2)
})

test('worktree.promote: a write in the main checkout before the check fails it, and the main checkout is not discarded', async (t) => {
  const s = await setup(t)
  // One of the main checkout's own sessions (they keep running) edits a file.
  promoteTestHooks.afterApply = (main) => writeFileSync(join(main, 'feat.txt'), 'edited by an agent in main\n')
  t.after(() => { delete promoteTestHooks.afterApply })
  const before = status(s.path)
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.error.code, 'CONFLICT')
  assert.match(r.error.message, /was not put back/)
  // The agent's edit and the carried work are both still in the main checkout, on feat.
  assert.equal(branchOf(s.app), 'feat')
  assert.equal(readFileSync(join(s.app, 'feat.txt'), 'utf8'), 'edited by an agent in main\n')
  assert.equal(readFileSync(join(s.app, 'untracked.txt'), 'utf8'), 'new\n')
  // The worktree is untouched, and the copy of its work is named.
  assert.deepEqual(status(s.path), before)
  const saved = /saved at (\S+\.patch)/.exec(r.error.message)
  assert.ok(saved && existsSync(saved[1]), r.error.message)
  assert.equal(s.repo().worktrees.length, 2)
})

test('worktree.promote and worktree.demote refuse IN_USE while another project has the checkout loaded', async (t) => {
  const s = await setup(t)
  const other = await s.call('project.create', { name: 'Q', repositories: [{ path: s.app }] })
  assert.equal(other.ok, true, JSON.stringify(other))
  const q = other.result.projectId
  await s.poller.refresh(s.app)
  const rows = s.projects.require(q).repositories[0].worktrees
  const theirs = rows.find((w) => realPath(w.path) === realPath(s.path))
  assert.ok(theirs)
  assert.equal((await s.call('worktree.load', { projectId: q, worktreeId: theirs.id })).ok, true)
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'IN_USE')
  assert.match(r.error.message, /Q/)
  assert.equal(branchOf(s.app), 'main')
  assert.equal((await s.call('worktree.unload', { projectId: q, worktreeId: theirs.id })).ok, true)
  assert.equal((await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })).ok, true)
  // Now the main checkout is on feat: another project's loaded main checkout refuses a demote.
  const theirMain = s.projects.require(q).repositories[0].worktrees.find((w) => w.isMain)
  assert.equal((await s.call('worktree.load', { projectId: q, worktreeId: theirMain.id })).ok, true)
  const d = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
  assert.equal(d.ok, false)
  assert.equal(d.error.code, 'IN_USE')
  assert.equal(branchOf(s.app), 'feat')
})

test('worktree.promote dryRun lists the main checkout\'s ignored files, and those the switch overwrites', async (t) => {
  const s = await setup(t)
  // feat tracks a file under the ignored folder; the main checkout has its own, ignored, copy.
  writeFileSync(join(s.path, 'ignored', 'tracked.cfg'), 'feat\n')
  git(s.path, 'add', '-f', 'ignored/tracked.cfg')
  git(s.path, 'commit', '-q', '-m', 'tracked cfg')
  mkdirSync(join(s.app, 'ignored'))
  writeFileSync(join(s.app, 'ignored', 'tracked.cfg'), 'mine\n')
  writeFileSync(join(s.app, 'ignored', 'cache'), 'x')
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId, dryRun: true })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.result.mainIgnored, ['ignored/'])
  assert.equal(r.result.mainIgnoredCount, 1)
  assert.deepEqual(r.result.overwrittenIgnored, ['ignored/tracked.cfg'])
  assert.equal(r.result.overwrittenIgnoredCount, 1)
})

test('worktree.promote, worktree.remove, worktree.pull and move.* refuse while a promote changes the repository', async (t) => {
  const s = await setup(t)
  promoteChanging.add(realPath(s.app))
  t.after(() => promoteChanging.clear())
  for (const [method, params] of [
    ['worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId }],
    ['worktree.remove', { projectId: s.projectId, worktreeId: s.worktreeId, force: true }],
    ['worktree.pull', { projectId: s.projectId, worktreeId: s.mainId }],
    ['move.prepare', { projectId: s.projectId, worktreeId: s.worktreeId }],
    ['move.export', { projectId: s.projectId, worktreeId: s.worktreeId }],
    ['move.receive', { projectId: s.projectId, repoId: s.repoId, branch: 'other', head: 'a'.repeat(40) }]
  ]) {
    const r = await s.call(method, params)
    assert.equal(r.ok, false, method)
    assert.equal(r.error.code, 'CONFLICT', `${method}: ${JSON.stringify(r.error)}`)
  }
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

test('worktree.demote: a write in the main checkout before its switch stops the undo there; nothing is discarded', async (t) => {
  const s = await promoted(t)
  // A session that stays in the main checkout edits feat.txt (tracked on feat, not on main): the switch refuses.
  promoteTestHooks.beforeSwitch = (main) => writeFileSync(join(main, 'feat.txt'), 'edited in main\n')
  t.after(() => { delete promoteTestHooks.beforeSwitch })
  const r = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.error.code, 'CONFLICT')
  assert.match(r.error.message, /was not put back/)
  assert.equal(branchOf(s.app), 'feat')
  assert.equal(readFileSync(join(s.app, 'feat.txt'), 'utf8'), 'edited in main\n')
  // The main checkout's work is in the new worktree, which is kept.
  assert.equal(branchOf(s.path), 'feat')
  assert.deepEqual(status(s.path), [' M README', '?? staged.txt', '?? untracked.txt'])
  assert.match(r.error.message, /saved at /)
})

test('worktree.demote: the worktrees not re-read after the commitment is a note; the sessions stay and resume in the main checkout', async (t) => {
  const s = await promoted(t)
  assert.equal((await s.call('worktree.load', { projectId: s.projectId, worktreeId: s.mainId })).ok, true)
  const refresh = s.poller.refresh.bind(s.poller)
  let failing = false
  s.poller.refresh = async (...args) => (failing ? false : refresh(...args))
  promoteTestHooks.beforeSwitch = () => { failing = true }
  t.after(() => { delete promoteTestHooks.beforeSwitch })
  const r = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.result.worktreeId, s.mainId)
  assert.deepEqual(r.result.moved, [])
  assert.ok(r.result.notes.some((n) => /could not be re-read/.test(n)), JSON.stringify(r.result.notes))
  assert.equal(branchOf(s.app), 'main')
  assert.equal(branchOf(s.path), 'feat')
  const main = s.repo().worktrees.find((w) => w.isMain)
  assert.equal(main.sessions.length, 3)
  assert.ok(main.sessions.every((x) => x.ptyId))
})

test('worktree.demote refuses when another worktree has the branch too', async (t) => {
  const s = await promoted(t)
  const side = join(s.dir, 'side')
  git(s.app, 'worktree', 'add', '-q', '--force', side, 'feat')
  const r = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'CONFLICT')
  assert.match(r.error.message, /side/)
  assert.ok(!existsSync(s.path))
  assert.equal(branchOf(s.app), 'feat')
})

test('worktree.demote dryRun lists the main checkout\'s ignored files, which stay', async (t) => {
  const s = await promoted(t)
  mkdirSync(join(s.app, 'ignored'), { recursive: true })
  writeFileSync(join(s.app, 'ignored', 'cache'), 'x')
  const r = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId, dryRun: true })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.result.mainIgnored, ['ignored/'])
  assert.deepEqual(r.result.overwrittenIgnored, [])
})

test('promote.answer: an unknown request is not accepted', async (t) => {
  const s = await setup(t)
  const r = await s.call('promote.answer', { projectId: s.projectId, requestId: 'nope', outcome: 'declined' })
  assert.deepEqual(r, { ok: true, result: { accepted: false } })
  const badOutcome = await s.call('promote.answer', { projectId: s.projectId, requestId: 'nope', outcome: 'maybe' })
  assert.equal(badOutcome.ok, false)
  // A window never says it promoted: worktree.promote with the requestId settles the request.
  const promoted = await s.call('promote.answer', { projectId: s.projectId, requestId: 'nope', outcome: 'promoted', worktreeId: s.mainId })
  assert.equal(promoted.ok, false)
  assert.equal(promoted.error.code, 'BAD_REQUEST')
  const unknown = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId, requestId: 'nope' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'NOT_FOUND')
  assert.ok(existsSync(s.path))
})


test('C1: a main checkout edited just before the switch (git refuses it) is left as it is, never discarded', async (t) => {
  const s = await setup(t)
  // A file main tracks and feat does not: the switch to feat would delete it.
  writeFileSync(join(s.app, 'conf.txt'), 'main version\n')
  git(s.app, 'add', 'conf.txt')
  git(s.app, 'commit', '-q', '-m', 'conf')
  // One of the main checkout's own sessions edits it after the last clean check.
  promoteTestHooks.beforePromoteSwitch = (main) => writeFileSync(join(main, 'conf.txt'), 'edited by an agent in main\n')
  t.after(() => { delete promoteTestHooks.beforePromoteSwitch })
  const before = status(s.path)
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.error.code, 'CONFLICT')
  assert.match(r.error.message, /was not put back: it is left as it is/)
  assert.equal(branchOf(s.app), 'main')
  assert.equal(readFileSync(join(s.app, 'conf.txt'), 'utf8'), 'edited by an agent in main\n')
  assert.deepEqual(status(s.path), before)
  assert.equal(s.repo().worktrees.length, 2)
})

test('C1: a main checkout that became dirty after the in-lock check is refused before the switch', async (t) => {
  const s = await setup(t)
  const refresh = s.poller.refresh.bind(s.poller)
  let calls = 0
  s.poller.refresh = async (...args) => {
    calls += 1
    // After the in-lock re-check read it clean: a session in the main checkout writes a file.
    if (calls === 2) setImmediate(() => writeFileSync(join(s.app, 'note.txt'), 'mine\n'))
    return refresh(...args)
  }
  promoteTestHooks.beforePromoteSwitch = () => assert.fail('the switch was reached')
  t.after(() => { delete promoteTestHooks.beforePromoteSwitch })
  // The write lands before the stopped agents are awaited (the worktree has none running): wait a tick there.
  const gone = s.sessions.terminals.whenGone.bind(s.sessions.terminals)
  s.sessions.terminals.whenGone = async (...args) => {
    await new Promise((res) => setTimeout(res, 20))
    return gone(...args)
  }
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.error.code, 'CONFLICT', JSON.stringify(r))
  assert.equal(branchOf(s.app), 'main')
  assert.equal(readFileSync(join(s.app, 'note.txt'), 'utf8'), 'mine\n')
  assert.ok(existsSync(s.path))
})

test('M1: a demote whose undo cannot give the main checkout its work back keeps the new worktree', async (t) => {
  const s = await promoted(t)
  // After the work is off the main checkout: a session that stays writes a file, and the demote fails.
  promoteTestHooks.beforeSwitch = (main) => {
    writeFileSync(join(main, 'extra.txt'), 'written meanwhile\n')
    throw new Error('boom')
  }
  t.after(() => { delete promoteTestHooks.beforeSwitch })
  const r = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.error.code, 'CONFLICT')
  assert.match(r.error.message, /was kept/)
  // The new worktree, with the work, is still there; the main checkout has its work back and the write.
  assert.equal(branchOf(s.path), 'feat')
  assert.deepEqual(status(s.path), [' M README', '?? staged.txt', '?? untracked.txt'])
  assert.equal(readFileSync(join(s.app, 'extra.txt'), 'utf8'), 'written meanwhile\n')
  assert.equal(readFileSync(join(s.app, 'untracked.txt'), 'utf8'), 'new\n')
})

test('M1: a demote that fails with the main checkout holding exactly its work again removes the new worktree', async (t) => {
  const s = await promoted(t)
  promoteTestHooks.beforeSwitch = () => { throw new Error('boom') }
  t.after(() => { delete promoteTestHooks.beforeSwitch })
  const before = status(s.app)
  const r = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.match(r.error.message, /boom/)
  assert.ok(!existsSync(s.path))
  assert.equal(branchOf(s.app), 'feat')
  assert.deepEqual(status(s.app), before)
})

test('M3: worktree.promote and worktree.demote refuse paths another operation has blocked', async (t) => {
  const s = await setup(t)
  const release = s.sessions.blockPath(s.path)
  for (const dryRun of [true, false]) {
    const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId, dryRun })
    assert.equal(r.ok, false, JSON.stringify(r))
    assert.equal(r.error.code, 'CONFLICT')
    assert.match(r.error.message, /another operation/)
  }
  release()
  const releaseMain = s.sessions.blockPath(s.app)
  const m = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(m.error?.code, 'CONFLICT')
  releaseMain()
  assert.equal(branchOf(s.app), 'main')
  assert.equal((await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })).ok, true)
  // The demote's target (the default worktree path) blocked.
  const releaseTarget = s.sessions.blockPath(s.path)
  const d = await s.call('worktree.demote', { projectId: s.projectId, repoId: s.repoId })
  assert.equal(d.ok, false, JSON.stringify(d))
  assert.equal(d.error.code, 'CONFLICT')
  releaseTarget()
  assert.equal(branchOf(s.app), 'feat')
})

test('M7: recovery files older than 30 days are pruned; newer ones and other files stay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-recovery-prune-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const name of ['old.patch', 'new.patch', 'old.txt']) writeFileSync(join(dir, name), 'x')
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  utimesSync(join(dir, 'old.patch'), old, old)
  utimesSync(join(dir, 'old.txt'), old, old)
  const removed = await pruneRecoveryFiles(dir)
  assert.deepEqual(removed, [join(dir, 'old.patch')])
  assert.deepEqual(readdirSync(dir).sort(), ['new.patch', 'old.txt'])
  // A missing folder is nothing to prune.
  assert.deepEqual(await pruneRecoveryFiles(join(dir, 'none')), [])
})

test('M8: a history folder the main checkout already has is left where it is, and said in a note', async (t) => {
  const s = await setup(t)
  mkdirSync(join(projectDir(s.app), CLAUDE_ID), { recursive: true })
  writeFileSync(join(projectDir(s.app), CLAUDE_ID, 'theirs.txt'), 'x')
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, true, JSON.stringify(r))
  const note = r.result.notes.find((n) => /were left at/.test(n))
  assert.ok(note, JSON.stringify(r.result.notes))
  assert.ok(note.includes(join(projectDir(s.path), CLAUDE_ID)))
  assert.ok(existsSync(join(projectDir(s.path), CLAUDE_ID, 'subagents', 'agent-1.jsonl')))
  assert.ok(existsSync(join(projectDir(s.app), CLAUDE_ID, 'theirs.txt')))
  // The conversation itself moved.
  assert.ok(existsSync(join(projectDir(s.app), `${CLAUDE_ID}.jsonl`)))
})

test('M9: records that cannot be updated after the commitment are a note; the promote went through', async (t) => {
  const s = await setup(t)
  const apply = s.projects.apply.bind(s.projects)
  s.projects.apply = (id, fn, ...rest) => {
    if (String(fn).includes('dropOrderKey')) throw new Error('disk full')
    return apply(id, fn, ...rest)
  }
  const r = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: s.worktreeId })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.result.moved, [])
  assert.ok(r.result.notes.some((n) => /records could not be updated \(disk full\)/.test(n)), JSON.stringify(r.result.notes))
  assert.equal(branchOf(s.app), 'feat')
  assert.ok(!existsSync(s.path))
})
