// scripts/serverMove.test.mjs — move.* (phase 5d): two servers' handlers in one process, against
// real git in a temp dir, with a bare repository as both clones' origin.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, symlinkSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { projectDir } from '../src/host/claudeSessionService.ts'
import { MAX_MOVE_CHUNK_BYTES, MOVE_TRANSFER_IDLE_MS, normalizeOrigin, sameOrigin } from '../src/shared/move.ts'
import { MoveTransfers, sweepStaleMoveDirs } from '../server/src/move/transfers.ts'
import { exportDirtyPatch, normalizeLinkedDir, PatchTooBigError } from '../src/host/gitService.ts'

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555'
const FRESH_ID = '99999999-2222-4333-8444-555555555555'

/** One server's handlers over its own config, projects and poller, with `clone` as its one repo. */
async function server(t, dir, name, clone, prWatchable = true) {
  const configPath = join(dir, `${name}.json`)
  saveConfig(configPath, { serverId: name, name, repos: [{ id: 'r', name: 'app', path: clone }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {}, onAttentionChange: () => {} })
  t.after(() => { poller.stop(); store.close() })
  const forgotten = []
  const polled = []
  const prWatch = { available: () => prWatchable, pollSoon: (...a) => polled.push(a), forget: (...a) => forgotten.push(a) }
  const sessions = { blockPath: () => () => {}, refreshAttention: () => {} }
  const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber: { send: () => {} }, projects, poller, sessions, prWatch })
  const created = await call('project.create', { name: `P-${name}`, repositories: [{ path: clone }] })
  const projectId = created.result.projectId
  await poller.refresh(clone)
  const project = () => projects.require(projectId)
  const repoId = project().repositories[0].id
  return { call, projects, poller, projectId, repoId, project, forgotten, polled, clone }
}

async function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-move-')))
  const home = process.env.HOME
  process.env.HOME = join(dir, 'home')
  t.after(() => { process.env.HOME = home; rmSync(dir, { recursive: true, force: true }) })
  const origin = join(dir, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv })
  const a = join(dir, 'a', 'app')
  const b = join(dir, 'b', 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  writeFileSync(join(a, 'README'), 'one\n')
  git(a, 'add', '.')
  git(a, 'commit', '-q', '-m', 'init')
  git(a, 'remote', 'add', 'origin', origin)
  git(a, 'push', '-q', 'origin', 'main')
  execFileSync('git', ['clone', '-q', origin, b], { env: gitEnv })
  const A = await server(t, dir, 'a', a)
  const B = await server(t, dir, 'b', b)
  // A worktree on A with a commit, work in progress and two sessions.
  const made = await A.call('worktree.create', { projectId: A.projectId, repoId: A.repoId, branch: 'feat', createBranch: true })
  assert.equal(made.ok, true, JSON.stringify(made))
  const worktreeId = made.result.worktreeId
  const path = A.project().repositories[0].worktrees.find((w) => w.id === worktreeId).path
  writeFileSync(join(path, 'feat.txt'), 'committed\n')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'feat')
  writeFileSync(join(path, 'README'), 'one\nchanged\n')
  writeFileSync(join(path, 'staged.txt'), 'staged\n')
  git(path, 'add', 'staged.txt')
  writeFileSync(join(path, 'untracked.txt'), 'new\n')
  mkdirSync(projectDir(path), { recursive: true })
  writeFileSync(join(projectDir(path), `${CLAUDE_ID}.jsonl`), '{"type":"user"}\n')
  A.projects.apply(A.projectId, (d) => {
    const wt = d.repositories[0].worktrees.find((w) => w.id === worktreeId)
    wt.sessions.push(
      { id: CLAUDE_ID, agentSessionId: CLAUDE_ID, title: 'Claude 1', llm: { provider: 'claude' }, queue: ['later'], status: 'idle' },
      { id: FRESH_ID, agentSessionId: FRESH_ID, title: 'Claude 2', llm: { provider: 'claude' }, queue: [], status: 'idle' },
      { id: 'codex-1', title: 'Codex 1', llm: { provider: 'codex' }, queue: [], status: 'idle' }
    )
    d.settings.worktreeTags = [{ id: 'a-review', name: 'Review', color: '#ffffff' }, { id: 'a-only', name: 'Only on A', color: '#ffffff' }]
    d.repositories[0].branchData.feat = { tag: 'a-review', note: 'the note', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3', prWatch: {}, env: 'PORT=1\n' }
  })
  B.projects.apply(B.projectId, (d) => {
    d.settings.worktreeTags = [{ id: 'b-review', name: 'Review', color: '#000000' }]
  })
  const ref = { projectId: A.projectId, worktreeId }
  return { dir, origin, a, b, A, B, worktreeId, path, ref }
}

/** Copies each carried history from A into a new transfer on B, chunk by chunk; the transfer id. */
async function copyHistories(s, sessions) {
  const begun = await s.B.call('move.begin', { projectId: s.B.projectId, repoId: s.B.repoId })
  assert.equal(begun.ok, true, JSON.stringify(begun))
  const { transferId } = begun.result
  let chunks = 0
  for (const session of sessions) {
    let offset = 0
    for (;;) {
      const chunk = await s.A.call('move.history', { ...s.ref, agentSessionId: session.agentSessionId, offset })
      assert.equal(chunk.ok, true, JSON.stringify(chunk))
      const up = await s.B.call('move.upload', { transferId, agentSessionId: session.agentSessionId, offset, data: chunk.result.data })
      assert.equal(up.ok, true, JSON.stringify(up))
      offset = up.result.size
      chunks++
      if (chunk.result.done) break
    }
  }
  return { transferId, chunks }
}

/** The whole move, as the app runs it: export, push, histories, receive, finish. */
async function move(s, { finish = true } = {}) {
  const exported = await s.A.call('move.export', s.ref)
  assert.equal(exported.ok, true, JSON.stringify(exported))
  const pushed = await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
  assert.equal(pushed.ok, true, JSON.stringify(pushed))
  const { fingerprint, notCarried, ...rest } = exported.result
  const { transferId, chunks } = await copyHistories(s, rest.sessions)
  const received = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: rest.branch, head: rest.head, patch: rest.patch, sessions: rest.sessions, branchData: rest.branchData, transferId })
  if (finish && received.ok) {
    const done = await s.A.call('move.finish', { ...s.ref, fingerprint })
    assert.equal(done.ok, true, JSON.stringify(done))
  }
  return { exported: exported.result, received, notCarried, chunks }
}

test('normalizeOrigin matches the ssh, https and file forms of one repository', () => {
  assert.equal(normalizeOrigin('git@github.com:Org/App.git'), 'github.com/Org/App')
  assert.equal(normalizeOrigin('ssh://git@GitHub.com:22/Org/App'), 'github.com/Org/App')
  assert.equal(normalizeOrigin('https://github.com/Org/App.git/'), 'github.com/Org/App')
  assert.equal(normalizeOrigin('/srv/git/app.git'), '/srv/git/app')
  assert.equal(normalizeOrigin('file:///srv/git/app.git'), '/srv/git/app')
  assert.equal(normalizeOrigin(''), null)
  assert.ok(sameOrigin('git@github.com:o/r.git', 'https://github.com/o/r'))
  assert.ok(!sameOrigin('git@github.com:o/r.git', 'https://github.com/o/other'))
  assert.ok(!sameOrigin(null, null))
})

test('move.prepare lists the branch, its origin and which sessions are carried', async (t) => {
  const s = await setup(t)
  const res = await s.A.call('move.prepare', s.ref)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.result.branch, 'feat')
  assert.equal(res.result.origin, s.origin)
  assert.equal(res.result.dirty, true)
  assert.equal(res.result.queuedPrompts, 1)
  assert.equal(res.result.prWatch, true)
  assert.deepEqual(res.result.sessions.map((x) => [x.title, x.carried]), [['Claude 1', true], ['Claude 2', false], ['Codex 1', false]])
  const main = s.A.project().repositories[0].worktrees.find((w) => w.isMain)
  assert.equal((await s.A.call('move.prepare', { projectId: s.A.projectId, worktreeId: main.id })).error?.code, 'BAD_REQUEST')
})

test('move.export refuses a loaded worktree and never touches the index', async (t) => {
  const s = await setup(t)
  s.A.projects.apply(s.A.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === s.worktreeId).loaded = true })
  assert.equal((await s.A.call('move.export', s.ref)).error?.code, 'IN_USE')
  s.A.projects.apply(s.A.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === s.worktreeId).loaded = false })
  const statusBefore = git(s.path, 'status', '--porcelain')
  const res = await s.A.call('move.export', s.ref)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(git(s.path, 'status', '--porcelain'), statusBefore, 'staged stays staged, untracked stays untracked')
  assert.match(res.result.patch, /untracked\.txt/)
  assert.match(res.result.patch, /staged\.txt/)
  assert.match(res.result.patch, /changed/)
  assert.equal(res.result.head, git(s.path, 'rev-parse', 'HEAD').trim())
  assert.deepEqual(res.result.sessions.map((x) => x.agentSessionId), [CLAUDE_ID])
  assert.equal(res.result.notCarried.length, 2)
  assert.deepEqual(res.result.branchData, { note: 'the note', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3', prWatch: true, env: 'PORT=1\n', tag: 'Review' })
})

test('move.candidates lists the repositories with the same origin, and why one is blocked', async (t) => {
  const s = await setup(t)
  const res = await s.B.call('move.candidates', { origin: s.origin, branch: 'feat' })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.result.length, 1)
  assert.equal(res.result[0].projectId, s.B.projectId)
  assert.equal(res.result[0].path, join(s.dir, 'b', 'app-feat'))
  assert.equal(res.result[0].blocked, undefined)
  assert.deepEqual((await s.B.call('move.candidates', { origin: 'git@github.com:other/repo.git', branch: 'feat' })).result, [])
  git(s.b, 'branch', 'feat')
  git(s.b, 'worktree', 'add', '-q', join(s.dir, 'elsewhere'), 'feat')
  const blocked = await s.B.call('move.candidates', { origin: s.origin, branch: 'feat' })
  assert.match(blocked.result[0].blocked, /already checked out/)
})

test('a move builds the worktree on the target and removes the source', async (t) => {
  const s = await setup(t)
  const { received, exported } = await move(s)
  assert.equal(received.ok, true, JSON.stringify(received))
  const target = join(s.dir, 'b', 'app-feat')
  const row = s.B.project().repositories[0].worktrees.find((w) => w.id === received.result.worktreeId)
  assert.equal(row.path, target)
  assert.equal(row.branch, 'feat')
  assert.equal(row.loaded, false)
  assert.equal(git(target, 'rev-parse', 'HEAD').trim(), exported.head)
  assert.equal(readFileSync(join(target, 'README'), 'utf8'), 'one\nchanged\n')
  assert.equal(readFileSync(join(target, 'untracked.txt'), 'utf8'), 'new\n')
  assert.equal(readFileSync(join(target, 'staged.txt'), 'utf8'), 'staged\n')
  assert.deepEqual(row.sessions.map((x) => [x.title, x.agentSessionId, x.queue.length]), [['Claude 1', CLAUDE_ID, 0]])
  assert.notEqual(row.sessions[0].id, CLAUDE_ID, 'a new server id')
  assert.equal(readFileSync(join(projectDir(target), `${CLAUDE_ID}.jsonl`), 'utf8'), '{"type":"user"}\n')
  const data = s.B.project().repositories[0].branchData.feat
  assert.deepEqual({ ...data, prWatch: !!data.prWatch }, { tag: 'b-review', note: 'the note', ticket: 'TOW-1', env: 'PORT=1\n', pr: 'https://github.com/o/r/pull/3', prWatch: true })
  assert.deepEqual(received.result.dropped, [])
  assert.equal(s.B.polled.length, 1, 'the watch polls soon on the target')
  // The source: gone from git and the project, its watch ended, its history kept (copied, not moved).
  assert.ok(!existsSync(s.path))
  assert.equal(s.A.project().repositories[0].worktrees.some((w) => w.id === s.worktreeId), false)
  assert.equal(s.A.project().repositories[0].branchData.feat.prWatch, undefined)
  assert.equal(s.A.forgotten.length, 1)
  assert.ok(existsSync(join(projectDir(s.path), `${CLAUDE_ID}.jsonl`)))
})

test('a tag the target lacks, and a PR watch without gh there, are reported as dropped', async (t) => {
  const s = await setup(t)
  s.A.projects.apply(s.A.projectId, (d) => { d.repositories[0].branchData.feat.tag = 'a-only' })
  const B = await server(t, s.dir, 'b2', s.b, false)
  s.B = B
  const { received } = await move(s)
  assert.equal(received.ok, true, JSON.stringify(received))
  assert.equal(received.result.dropped.length, 2)
  assert.match(received.result.dropped.join('\n'), /Only on A/)
  assert.match(received.result.dropped.join('\n'), /gh is not signed in/)
  assert.equal(B.project().repositories[0].branchData.feat.prWatch, undefined)
})

test('move.receive undoes everything when origin is not at the source head', async (t) => {
  const s = await setup(t)
  const exported = (await s.A.call('move.export', s.ref)).result
  await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
  const { transferId } = await copyHistories(s, exported.sessions)
  const res = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: 'a'.repeat(40), patch: exported.patch, sessions: exported.sessions, branchData: {}, transferId })
  assert.equal(res.error?.code, 'CONFLICT')
  assert.equal(git(s.b, 'branch', '--list', 'feat').trim(), '')
  assert.ok(!existsSync(join(s.dir, 'b', 'app-feat')))
})

test('move.receive undoes the worktree, the branch and the histories when the patch fails', async (t) => {
  const s = await setup(t)
  const exported = (await s.A.call('move.export', s.ref)).result
  await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
  const target = join(s.dir, 'b', 'app-feat')
  const { transferId } = await copyHistories(s, exported.sessions)
  const res = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: exported.head, patch: 'diff --git a/x b/x\nnot a patch\n', sessions: exported.sessions, branchData: exported.branchData, transferId })
  assert.equal(res.error?.code, 'GIT_ERROR', JSON.stringify(res))
  assert.ok(!existsSync(target))
  assert.equal(git(s.b, 'branch', '--list', 'feat').trim(), '')
  assert.ok(!existsSync(join(projectDir(target), `${CLAUDE_ID}.jsonl`)))
  assert.ok(!existsSync(projectDir(target)), 'the history dir it created goes too')
  assert.equal(s.B.project().repositories[0].worktrees.length, 1)
  assert.equal(s.B.project().repositories[0].branchData.feat, undefined)
})

test('move.finish keeps a source that changed after the export', async (t) => {
  const s = await setup(t)
  const exported = (await s.A.call('move.export', s.ref)).result
  const checked = await s.A.call('move.finish', { ...s.ref, fingerprint: exported.fingerprint, verifyOnly: true })
  assert.equal(checked.ok, true, JSON.stringify(checked))
  assert.ok(existsSync(s.path), 'verifyOnly removes nothing')
  writeFileSync(join(s.path, 'later.txt'), 'typed after the copy\n')
  assert.equal((await s.A.call('move.finish', { ...s.ref, fingerprint: exported.fingerprint, verifyOnly: true })).error?.code, 'CONFLICT')
  const res = await s.A.call('move.finish', { ...s.ref, fingerprint: exported.fingerprint })
  assert.equal(res.error?.code, 'CONFLICT')
  assert.ok(existsSync(join(s.path, 'later.txt')))
  assert.equal((await s.A.call('move.finish', { ...s.ref, fingerprint: 'nope' })).error?.code, 'BAD_REQUEST')
})

test('move.receive validates what it is given', async (t) => {
  const s = await setup(t)
  const base = { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: 'a'.repeat(40), patch: '', sessions: [], branchData: {} }
  const code = async (over) => (await s.B.call('move.receive', { ...base, ...over })).error?.code
  // A clean worktree's patch is '': only the head (not on origin) refuses this one.
  assert.equal(await code({}), 'GIT_ERROR')
  assert.equal(await code({ head: 'HEAD' }), 'BAD_REQUEST')
  assert.equal(await code({ branch: '-x' }), 'BAD_REQUEST')
  const one = { title: 't', llm: { provider: 'claude' }, agentSessionId: CLAUDE_ID, historyBytes: 5, historySha256: 'a'.repeat(64) }
  assert.equal(await code({ sessions: [{ ...one, llm: { provider: 'codex' } }] }), 'BAD_REQUEST')
  assert.equal(await code({ sessions: [{ ...one, agentSessionId: '../x' }] }), 'BAD_REQUEST')
  assert.equal(await code({ sessions: [{ ...one, historyBytes: 64 * 1024 * 1024 + 1 }] }), 'BAD_REQUEST')
  assert.equal(await code({ sessions: [one, one] }), 'BAD_REQUEST', 'a repeated session')
  assert.equal(await code({ sessions: [one] }), 'BAD_REQUEST', 'sessions need a transfer')
  const missing = await s.B.call('move.receive', { ...base, sessions: [one], transferId: '00000000-0000-4000-8000-000000000000' })
  assert.equal(missing.error?.code, 'NOT_FOUND', JSON.stringify(missing))
  assert.equal(await code({ branchData: { note: 5 } }), 'BAD_REQUEST')
  assert.equal(await code({ repoId: 'nope' }), 'NOT_FOUND')
})

test('move.export leaves out the linked dirs (the target links them itself) and refuses non-UTF-8 text', async (t) => {
  const s = await setup(t)
  mkdirSync(join(s.a, '.trek'))
  await s.A.call('repo.update', { projectId: s.A.projectId, repoId: s.A.repoId, linkedDirs: ['.trek'] })
  symlinkSync(join(s.a, '.trek'), join(s.path, '.trek'))
  const res = await s.A.call('move.export', s.ref)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.doesNotMatch(res.result.patch, /\.trek/)
  writeFileSync(join(s.path, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  const refused = await s.A.call('move.export', s.ref)
  assert.equal(refused.error?.code, 'BAD_REQUEST')
  assert.match(refused.error.message, /not UTF-8/)
})

test('a history bigger than one chunk (and than a frame) arrives whole, in order', async (t) => {
  const s = await setup(t)
  // 17 MiB: five chunks, and more than the server's 16 MiB frame.
  const line = JSON.stringify({ type: 'assistant', text: 'x'.repeat(1000) }) + '\n'
  const big = line.repeat(Math.ceil((17 * 1024 * 1024) / line.length))
  writeFileSync(join(projectDir(s.path), `${CLAUDE_ID}.jsonl`), big)
  const { received, chunks } = await move(s)
  assert.equal(received.ok, true, JSON.stringify(received))
  assert.equal(chunks, Math.ceil(Buffer.byteLength(big) / MAX_MOVE_CHUNK_BYTES))
  assert.equal(readFileSync(join(projectDir(join(s.dir, 'b', 'app-feat')), `${CLAUDE_ID}.jsonl`), 'utf8'), big)
})

test('a history that did not arrive whole is refused, and nothing stays staged or built', async (t) => {
  const s = await setup(t)
  const exported = (await s.A.call('move.export', s.ref)).result
  await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
  const begun = (await s.B.call('move.begin', { projectId: s.B.projectId, repoId: s.B.repoId })).result
  await s.B.call('move.upload', { transferId: begun.transferId, agentSessionId: CLAUDE_ID, offset: 0, data: Buffer.from('{"type"').toString('base64') })
  const res = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: exported.head, patch: exported.patch, sessions: exported.sessions, branchData: {}, transferId: begun.transferId })
  assert.equal(res.error?.code, 'BAD_REQUEST', JSON.stringify(res))
  assert.match(res.error.message, /did not arrive whole/)
  assert.ok(!existsSync(join(s.dir, 'b', 'app-feat')))
  assert.equal(git(s.b, 'branch', '--list', 'feat').trim(), '')
  assert.equal((await s.B.call('move.upload', { transferId: begun.transferId, agentSessionId: CLAUDE_ID, offset: 7, data: 'AAAA' })).error?.code, 'NOT_FOUND', 'the transfer went with the receive')
})

test('move.history reads only a carried history of an unloaded worktree', async (t) => {
  const s = await setup(t)
  assert.equal((await s.A.call('move.history', { ...s.ref, agentSessionId: FRESH_ID, offset: 0 })).error?.code, 'NOT_FOUND', 'no saved conversation')
  assert.equal((await s.A.call('move.history', { ...s.ref, agentSessionId: CLAUDE_ID, offset: -1 })).error?.code, 'BAD_REQUEST')
  assert.equal((await s.A.call('move.history', { ...s.ref, agentSessionId: CLAUDE_ID, offset: 9999 })).error?.code, 'BAD_REQUEST')
  const whole = await s.A.call('move.history', { ...s.ref, agentSessionId: CLAUDE_ID, offset: 0 })
  assert.deepEqual({ ...whole.result, data: Buffer.from(whole.result.data, 'base64').toString() }, { data: '{"type":"user"}\n', offset: 0, total: 16, done: true })
  s.A.projects.apply(s.A.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === s.worktreeId).loaded = true })
  assert.equal((await s.A.call('move.history', { ...s.ref, agentSessionId: CLAUDE_ID, offset: 0 })).error?.code, 'IN_USE')
})

test('transfers: chunks in order, the limits, abort, and an idle one swept', async (t) => {
  let now = 1000
  const transfers = new MoveTransfers(() => now)
  t.after(() => transfers.clear())
  const id = await transfers.begin('p', 'r')
  const chunk = Buffer.from('abcd').toString('base64')
  assert.equal(await transfers.append(id, CLAUDE_ID, 0, chunk), 4)
  await assert.rejects(transfers.append(id, CLAUDE_ID, 0, chunk), /starts at 4/)
  assert.equal(await transfers.append(id, CLAUDE_ID, 4, chunk), 8)
  await assert.rejects(transfers.append(id, CLAUDE_ID, 8, 'not base64!'), /base64/)
  await assert.rejects(transfers.append(id, '../etc', 0, chunk), /session id/)
  await assert.rejects(transfers.append(id, CLAUDE_ID, 8, Buffer.alloc(MAX_MOVE_CHUNK_BYTES + 1).toString('base64')), /at most/)
  assert.throws(() => transfers.take(id, 'p', 'other'), /another repository/)
  const staged = transfers.take(id, 'p', 'r')
  assert.equal(readFileSync(staged.file(CLAUDE_ID), 'utf8'), 'abcdabcd')
  await staged.discard()
  assert.ok(!existsSync(staged.file(CLAUDE_ID)))
  const second = await transfers.begin('p', 'r')
  await transfers.append(second, CLAUDE_ID, 0, chunk)
  await transfers.abort(second)
  await transfers.abort(second)
  await assert.rejects(transfers.append(second, CLAUDE_ID, 4, chunk), /No such transfer/)
  const idle = await transfers.begin('p', 'r')
  now += MOVE_TRANSFER_IDLE_MS + 1
  await transfers.sweep()
  assert.equal(transfers.size, 0)
  await assert.rejects(transfers.append(idle, CLAUDE_ID, 0, chunk), /No such transfer/)
  const ids = []
  for (let i = 0; i < 4; i++) ids.push(await transfers.begin('p', 'r'))
  await assert.rejects(transfers.begin('p', 'r'), /at most 4/)
})

/** Runs `fn` with a global git config holding `text` (restored after). */
function withGlobalConfig(t, dir, text) {
  const file = join(dir, 'gitconfig')
  writeFileSync(file, text)
  const before = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = file
  t.after(() => { process.env.GIT_CONFIG_GLOBAL = before })
}

test('the patch ignores textconv drivers, diff.noprefix and diff.context: binary files arrive byte for byte', async (t) => {
  const s = await setup(t)
  const bin = Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 10, 0, 42])
  writeFileSync(join(s.path, '.gitattributes'), '*.bin diff=hex\n')
  writeFileSync(join(s.path, 'data.bin'), bin)
  git(s.path, 'add', '.gitattributes', 'data.bin')
  git(s.path, 'commit', '-q', '-m', 'bin')
  const changed = Buffer.concat([bin, Buffer.from([7, 0, 9])])
  writeFileSync(join(s.path, 'data.bin'), changed)
  writeFileSync(join(s.path, 'new.bin'), Buffer.from([0, 0, 5, 6, 0]))
  withGlobalConfig(t, s.dir, '[diff "hex"]\n\ttextconv = od -An -tx1\n[diff]\n\tnoprefix = true\n\tcontext = 0\n\tmnemonicPrefix = true\n\trenames = copies\n[color]\n\tui = always\n')
  const { received, exported } = await move(s)
  assert.equal(received.ok, true, JSON.stringify(received))
  assert.match(exported.patch, /^diff --git a\/README b\/README$/m)
  assert.match(exported.patch, /GIT binary patch/)
  const target = join(s.dir, 'b', 'app-feat')
  assert.deepEqual(readFileSync(join(target, 'data.bin')), changed)
  assert.deepEqual(readFileSync(join(target, 'new.bin')), Buffer.from([0, 0, 5, 6, 0]))
  assert.equal(readFileSync(join(target, 'README'), 'utf8'), 'one\nchanged\n')
  assert.ok(!existsSync(s.path), 'the source went only once the target matched')
})

test('move.receive undoes everything when the applied work does not match the source', async (t) => {
  const s = await setup(t)
  // On B, untracked.txt is ignored: after the apply it would vanish from the worktree's changes.
  writeFileSync(join(s.b, '.git', 'info', 'exclude'), 'untracked.txt\n')
  const { received } = await move(s, { finish: false })
  assert.equal(received.error?.code, 'GIT_ERROR', JSON.stringify(received))
  assert.match(received.error.message, /does not match/)
  const target = join(s.dir, 'b', 'app-feat')
  assert.ok(!existsSync(target))
  assert.equal(git(s.b, 'branch', '--list', 'feat').trim(), '')
  assert.equal(s.B.project().repositories[0].branchData.feat, undefined)
  assert.ok(existsSync(s.path), 'the source is untouched')
})

test('normalizeLinkedDir: trimmed, inside the repository, never the root itself', () => {
  for (const bad of ['', ' ', '/', '//', '.', './', '..', '../x', 'a/../..', '/abs', '/abs/x']) {
    assert.equal(normalizeLinkedDir(bad), null, JSON.stringify(bad))
  }
  assert.equal(normalizeLinkedDir(' .trek/ '), '.trek')
  assert.equal(normalizeLinkedDir('./a/./b//'), 'a/b')
  assert.equal(normalizeLinkedDir('a/../b'), 'b')
})

test('repo.update refuses linkedDirs that are empty, the root, absolute or escaping', async (t) => {
  const s = await setup(t)
  for (const bad of [[''], ['.'], ['./'], ['/'], ['../x'], ['/etc'], ['ok', ' ']]) {
    const res = await s.A.call('repo.update', { projectId: s.A.projectId, repoId: s.A.repoId, linkedDirs: bad })
    assert.equal(res.error?.code, 'BAD_REQUEST', JSON.stringify(bad))
  }
  assert.equal((await s.A.call('repo.update', { projectId: s.A.projectId, repoId: s.A.repoId, linkedDirs: [' .trek/ '] })).ok, true)
})

test('move.export carries everything even when stored linkedDirs are empty or the root', async (t) => {
  const s = await setup(t)
  s.A.projects.apply(s.A.projectId, (d) => { d.repositories[0].linkedDirs = ['', '.', './', '/', ' untracked.txt'] })
  const res = await s.A.call('move.export', s.ref)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.match(res.result.patch, /README/)
  assert.match(res.result.patch, /staged\.txt/)
  assert.doesNotMatch(res.result.patch, /untracked\.txt/, "' untracked.txt' is the linked dir untracked.txt")
})

test('move.prepare lists ignored files and assume-unchanged / skip-worktree files, which do not move', async (t) => {
  const s = await setup(t)
  mkdirSync(join(s.a, '.trek'))
  await s.A.call('repo.update', { projectId: s.A.projectId, repoId: s.A.repoId, linkedDirs: ['.trek'] })
  symlinkSync(join(s.a, '.trek'), join(s.path, '.trek'))
  writeFileSync(join(s.path, '.gitignore'), '*.log\n.trek\nbuild/\n')
  writeFileSync(join(s.path, 'debug.log'), 'x\n')
  mkdirSync(join(s.path, 'build'))
  writeFileSync(join(s.path, 'build', 'out.js'), 'x\n')
  git(s.path, 'update-index', '--assume-unchanged', 'feat.txt')
  git(s.path, 'update-index', '--skip-worktree', 'README')
  const res = await s.A.call('move.prepare', s.ref)
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(res.result.ignored, ['build/', 'debug.log'])
  assert.equal(res.result.ignoredCount, 2)
  assert.deepEqual(res.result.hiddenChanges, ['README', 'feat.txt'])
  assert.equal(res.result.hiddenChangesCount, 2)
})

test('move.unreceive undoes a receive: the worktree, its branch, the branch data, the PR watch, the histories', async (t) => {
  const s = await setup(t)
  s.B.projects.apply(s.B.projectId, (d) => { d.repositories[0].branchData.feat = { note: 'b note' } })
  const { received } = await move(s, { finish: false })
  assert.equal(received.ok, true, JSON.stringify(received))
  const token = received.result.undoToken
  assert.match(token, /^[0-9a-f-]{36}$/)
  const target = join(s.dir, 'b', 'app-feat')
  assert.equal(s.B.project().repositories[0].branchData.feat.note, 'the note')
  const ref = { projectId: s.B.projectId, repoId: s.B.repoId }
  assert.equal((await s.B.call('move.unreceive', { ...ref, undoToken: '00000000-0000-4000-8000-000000000000' })).error?.code, 'NOT_FOUND')
  assert.equal((await s.B.call('move.unreceive', { ...ref, repoId: 'nope', undoToken: token })).error?.code, 'NOT_FOUND')
  const res = await s.B.call('move.unreceive', { ...ref, undoToken: token })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.ok(!existsSync(target))
  assert.equal(git(s.b, 'branch', '--list', 'feat').trim(), '', 'the branch it created goes')
  assert.equal(s.B.project().repositories[0].worktrees.length, 1)
  assert.deepEqual(s.B.project().repositories[0].branchData.feat, { note: 'b note' })
  assert.equal(s.B.forgotten.length, 1, 'the watch it started ends')
  assert.ok(!existsSync(projectDir(target)), 'the history dir it created goes')
  assert.equal((await s.B.call('move.unreceive', { ...ref, undoToken: token })).error?.code, 'NOT_FOUND', 'once only')
  assert.ok(existsSync(s.path), 'the source is untouched')
})

test('move.unreceive keeps a target copy that changed after the receive', async (t) => {
  const s = await setup(t)
  const { received } = await move(s, { finish: false })
  assert.equal(received.ok, true, JSON.stringify(received))
  const target = join(s.dir, 'b', 'app-feat')
  writeFileSync(join(target, 'typed-on-b.txt'), 'x\n')
  const res = await s.B.call('move.unreceive', { projectId: s.B.projectId, repoId: s.B.repoId, undoToken: received.result.undoToken })
  assert.equal(res.error?.code, 'CONFLICT', JSON.stringify(res))
  assert.ok(existsSync(join(target, 'typed-on-b.txt')))
})

test('the untracked files are measured before they are hashed; a patch over the buffer is "too big"', async (t) => {
  const s = await setup(t)
  writeFileSync(join(s.path, 'huge.bin'), Buffer.alloc(9 * 1024 * 1024, 1))
  const res = await s.A.call('move.export', s.ref)
  assert.equal(res.error?.code, 'BAD_REQUEST', JSON.stringify(res))
  assert.match(res.error.message, /untracked files/)
  rmSync(join(s.path, 'huge.bin'))
  writeFileSync(join(s.path, 'README'), 'y\n'.repeat(100_000))
  await assert.rejects(exportDirtyPatch(s.path, [], { maxBytes: 1024 }), (err) => err instanceof PatchTooBigError && /too big|at most/.test(err.message))
})

test('two sessions sharing one conversation are carried once', async (t) => {
  const s = await setup(t)
  s.A.projects.apply(s.A.projectId, (d) => {
    d.repositories[0].worktrees.find((w) => w.id === s.worktreeId).sessions.push({ id: 'dup', agentSessionId: CLAUDE_ID, title: 'Claude 1 again', llm: { provider: 'claude' }, queue: [], status: 'idle' })
  })
  const plan = await s.A.call('move.prepare', s.ref)
  const dup = plan.result.sessions.find((x) => x.title === 'Claude 1 again')
  assert.equal(dup.carried, false)
  assert.match(dup.reason, /Claude 1/)
  const { received, exported } = await move(s)
  assert.equal(received.ok, true, JSON.stringify(received))
  assert.equal(exported.sessions.length, 1)
})

test('move.receive limits sessionTypeName like a title; move.candidates blocks an invalid branch name', async (t) => {
  const s = await setup(t)
  const one = { title: 't', llm: { provider: 'claude' }, agentSessionId: CLAUDE_ID, historyBytes: 5, historySha256: 'a'.repeat(64), sessionTypeName: 'x'.repeat(201) }
  const res = await s.B.call('move.receive', { projectId: s.B.projectId, repoId: s.B.repoId, branch: 'feat', head: 'a'.repeat(40), patch: '', sessions: [one], branchData: {} })
  assert.equal(res.error?.code, 'BAD_REQUEST')
  assert.match(res.error.message, /sessionTypeName/)
  const candidates = await s.B.call('move.candidates', { origin: s.origin, branch: 'a..b' })
  assert.equal(candidates.ok, true, JSON.stringify(candidates))
  assert.match(candidates.result[0].blocked, /not a valid branch name/)
})

test('two receives of one branch at once: one builds it, the other is refused and leaves it alone', async (t) => {
  const s = await setup(t)
  const exported = (await s.A.call('move.export', s.ref)).result
  await s.A.call('worktree.push', { ...s.ref, setUpstream: true })
  const one = await copyHistories(s, exported.sessions)
  const two = await copyHistories(s, exported.sessions)
  const params = (transferId) => ({ projectId: s.B.projectId, repoId: s.B.repoId, branch: exported.branch, head: exported.head, patch: exported.patch, sessions: exported.sessions, branchData: exported.branchData, transferId })
  const results = await Promise.all([s.B.call('move.receive', params(one.transferId)), s.B.call('move.receive', params(two.transferId))])
  const ok = results.filter((r) => r.ok)
  assert.equal(ok.length, 1, JSON.stringify(results))
  assert.equal(results.find((r) => !r.ok).error.code, 'CONFLICT')
  const target = join(s.dir, 'b', 'app-feat')
  assert.equal(readFileSync(join(target, 'untracked.txt'), 'utf8'), 'new\n')
  assert.equal(readFileSync(join(projectDir(target), `${CLAUDE_ID}.jsonl`), 'utf8'), '{"type":"user"}\n')
  assert.equal(git(s.b, 'branch', '--list', 'feat').trim().replace(/^[+*] /, ''), 'feat')
})

test('transfers: an abort during a write drops the transfer once the write ends', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-move-root-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const transfers = new MoveTransfers(Date.now, root)
  const id = await transfers.begin('p', 'r')
  const writing = transfers.append(id, CLAUDE_ID, 0, Buffer.alloc(MAX_MOVE_CHUNK_BYTES, 1).toString('base64'))
  // Wait until the chunk is being written (the store's own record says so), then abort.
  const record = transfers.transfers.get(id)
  for (let i = 0; i < 1000 && !record.busy; i++) await new Promise((r) => setImmediate(r))
  assert.equal(record.busy, true, 'caught the write in progress')
  await transfers.abort(id)
  assert.equal(readdirSync(root).length, 1, 'kept while the write runs')
  await writing
  assert.deepEqual(readdirSync(root), [])
  await assert.rejects(transfers.append(id, CLAUDE_ID, 4, 'AAAA'), /No such transfer/)
})

test('sweepStaleMoveDirs removes only our own trek-move dirs older than an hour', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-move-root-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = (Date.now() - 2 * 3600_000) / 1000
  for (const name of ['trek-move-abc123', 'trek-move-index-abc123', 'trek-move-fresh1', 'other-old']) {
    mkdirSync(join(root, name))
    writeFileSync(join(root, name, 'f'), 'x')
    if (name !== 'trek-move-fresh1') utimesSync(join(root, name), old, old)
  }
  await sweepStaleMoveDirs(root)
  assert.deepEqual(readdirSync(root).sort(), ['other-old', 'trek-move-fresh1'])
})
