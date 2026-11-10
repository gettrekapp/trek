// scripts/serverMove.test.mjs — move.* (phase 5d): two servers' handlers in one process, against
// real git in a temp dir, with a bare repository as both clones' origin.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
import { MoveTransfers } from '../server/src/move/transfers.ts'

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
