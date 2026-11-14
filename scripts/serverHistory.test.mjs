// scripts/serverHistory.test.mjs — worktree history: what each change records, and history.list.
// Keep a user's global git config and hooks out of the real git these tests run.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore } from '../server/src/history/store.ts'
import { MAX_HISTORY_REASON, MAX_VALUE_TEXT } from '../src/shared/model/history.ts'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { BRANCH_SET_METHODS, dispatchV2 } from '../server/src/v2.ts'
import { welcomeCapabilities } from '../server/src/capabilities.ts'
import { BY_TREK, branchChanges, recordHistory, tagValue } from '../server/src/history/record.ts'

const settings = {
  worktreeTags: [{ id: 'ip', name: 'In Progress', color: '#5dabef' }, { id: 'rv', name: 'Review', color: '#ffaa00' }],
  customTags: [{ id: 'bl', name: 'Blocked', color: '#ff0000' }, { id: 'ui', name: 'UI', color: '#00ff00' }]
}

function dirFor(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-history-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'history')
}
const storeFor = (t) => new HistoryStore(dirFor(t))

test('tagValue snapshots the name and colour; an unknown id keeps its id as the text', () => {
  assert.deepEqual(tagValue(settings.worktreeTags, 'rv'), { id: 'rv', text: 'Review', color: '#ffaa00' })
  assert.deepEqual(tagValue(settings.worktreeTags, 'gone'), { id: 'gone', text: 'gone' })
  assert.equal(tagValue(settings.worktreeTags, undefined), undefined)
})

test('branchChanges: one change per field that changed, none for the same value or env', () => {
  assert.deepEqual(branchChanges('tag', 'ip', 'rv', settings), [{ kind: 'status', from: tagValue(settings.worktreeTags, 'ip'), to: tagValue(settings.worktreeTags, 'rv') }])
  assert.deepEqual(branchChanges('tag', undefined, 'rv', settings), [{ kind: 'status', to: tagValue(settings.worktreeTags, 'rv') }])
  assert.deepEqual(branchChanges('tag', 'rv', 'rv', settings), [])
  assert.deepEqual(branchChanges('customTags', ['bl'], ['ui'], settings), [
    { kind: 'label.added', to: tagValue(settings.customTags, 'ui') },
    { kind: 'label.removed', from: tagValue(settings.customTags, 'bl') }
  ])
  assert.deepEqual(branchChanges('customTags', ['bl'], ['bl'], settings), [])
  assert.deepEqual(branchChanges('note', undefined, 'n', settings), [{ kind: 'note', to: { text: 'added' } }])
  assert.deepEqual(branchChanges('note', 'n', 'm', settings), [{ kind: 'note', to: { text: 'edited' } }])
  assert.deepEqual(branchChanges('note', 'n', undefined, settings), [{ kind: 'note', to: { text: 'cleared' } }])
  assert.deepEqual(branchChanges('ticket', 'A-1', 'A-2', settings), [{ kind: 'ticket', from: { text: 'A-1' }, to: { text: 'A-2' } }])
  assert.deepEqual(branchChanges('pr', undefined, 'https://github.com/o/r/pull/1', settings), [{ kind: 'pr', to: { text: 'https://github.com/o/r/pull/1' } }])
  assert.deepEqual(branchChanges('env', 'A=1', 'A=2', settings), [])
})

test('recordHistory: the context attribution (the user by default), a given one, and no branch records nothing', (t) => {
  const history = storeFor(t)
  recordHistory({ history }, 'p', 'r', 'feat', [{ kind: 'created' }])
  recordHistory({ history, attribution: { actor: { kind: 'mcp', terminalId: 't1', sessionTitle: 'Claude' }, reason: 'asked' } }, 'p', 'r', 'feat', [{ kind: 'removed' }])
  recordHistory({ history }, 'p', 'r', 'feat', [{ kind: 'status', to: { text: 'X' } }], BY_TREK)
  recordHistory({ history }, 'p', 'r', undefined, [{ kind: 'created' }])
  recordHistory({}, 'p', 'r', 'feat', [{ kind: 'created' }])
  const events = history.list('p', 'r', 'feat').events
  assert.deepEqual(events.map((e) => [e.kind, e.actor, e.reason]), [
    ['status', { kind: 'trek' }, undefined],
    ['removed', { kind: 'mcp', terminalId: 't1', sessionTitle: 'Claude' }, 'asked'],
    ['created', { kind: 'user' }, undefined]
  ])
  assert.equal('from' in events[0], false, 'no undefined keys')
})

test('recordHistory folds a quick note edit by the same actor into the newest note entry', (t) => {
  const history = storeFor(t)
  const ctx = { history }
  recordHistory(ctx, 'p', 'r', 'feat', [{ kind: 'note', to: { text: 'added' } }], undefined, 1000)
  recordHistory(ctx, 'p', 'r', 'feat', [{ kind: 'note', to: { text: 'edited' } }], undefined, 2000)
  let events = history.list('p', 'r', 'feat').events
  assert.deepEqual(events.map((e) => [e.kind, e.at, e.to.text]), [['note', 2000, 'added']])
  // Another actor, or later than NOTE_COALESCE_MS, is its own entry.
  recordHistory(ctx, 'p', 'r', 'feat', [{ kind: 'note', to: { text: 'edited' } }], { actor: { kind: 'mcp' } }, 3000)
  recordHistory(ctx, 'p', 'r', 'feat', [{ kind: 'note', to: { text: 'edited' } }], { actor: { kind: 'mcp' } }, 3000 + 5 * 60_000)
  events = history.list('p', 'r', 'feat').events
  assert.equal(events.length, 3)
  // A clear folded in reads as cleared.
  recordHistory(ctx, 'p', 'r', 'feat', [{ kind: 'note', to: { text: 'cleared' } }], { actor: { kind: 'mcp' } }, 3001 + 5 * 60_000)
  assert.equal(history.list('p', 'r', 'feat').events[0].to.text, 'cleared')
})

test('long text is clamped when recorded, so the entry survives a reload', (t) => {
  const dir = dirFor(t)
  const history = new HistoryStore(dir)
  const [c] = branchChanges('ticket', undefined, 'T'.repeat(3000), settings)
  assert.equal(c.to.text.length, MAX_VALUE_TEXT)
  recordHistory({ history }, 'p', 'r', 'feat', [c], { actor: { kind: 'mcp' }, reason: 'R'.repeat(900) })
  const [e] = history.list('p', 'r', 'feat').events
  assert.equal(e.reason.length, MAX_HISTORY_REASON)
  const again = new HistoryStore(dir)
  assert.equal(again.list('p', 'r', 'feat').events.length, 1)
})

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

/** A project on a real repo, with a history store and a fake PR watch; `call` throws a refusal. */
async function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-history-v2-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  execFileSync('git', ['-C', a, 'commit', '--allow-empty', '-q', '-m', 'init'], { env: gitEnv })
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
  t.after(() => { poller.stop(); store.close() })
  const history = new HistoryStore(join(dir, 'history'))
  const sessions = { forgetProject() {}, forgetRepo() {}, forgetGlobal() {}, refreshAttention() {}, blockPath: () => () => {} }
  const prWatch = { available: () => true, pollSoon() {}, forget() {} }
  const ctx = { store, hub, subscriber: { send() {} }, projects, poller, sessions, terminal: { send() {}, bufferedAmount: () => 0 }, history, prWatch }
  const call = async (method, params, extra = {}) => {
    const outcome = await dispatchV2(method, params, { ...ctx, ...extra })
    if (!outcome.ok) throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code })
    return outcome.result
  }
  const { projectId } = await call('project.create', { name: 'P', repositories: [{ path: a }] })
  await poller.refresh(a)
  const repoId = projects.require(projectId).repositories[0].id
  const kinds = (branch = 'feat') => history.list(projectId, repoId, branch).events.map((e) => e.kind)
  return { dir, a, call, ctx, projects, projectId, repoId, history, kinds }
}

test('history.list pages a branch newest first; limit and before are checked', async (t) => {
  const s = await setup(t)
  for (const kind of ['created', 'promoted', 'demoted']) recordHistory(s.ctx, s.projectId, s.repoId, 'feat', [{ kind }])
  const page = await s.call('history.list', { projectId: s.projectId, repoId: s.repoId, branch: 'feat', limit: 2 })
  assert.deepEqual(page.events.map((e) => e.kind), ['demoted', 'promoted'])
  assert.equal(page.more, true)
  const older = await s.call('history.list', { projectId: s.projectId, repoId: s.repoId, branch: 'feat', before: page.events[1].id })
  assert.deepEqual(older.events.map((e) => e.kind), ['created'])
  assert.equal(older.more, false)
  await assert.rejects(s.call('history.list', { projectId: s.projectId, repoId: s.repoId, branch: 'feat', limit: 101 }), (e) => e.code === 'BAD_REQUEST')
  await assert.rejects(s.call('history.list', { projectId: s.projectId, repoId: s.repoId, branch: 'feat', before: 3 }), (e) => e.code === 'BAD_REQUEST')
  await assert.rejects(s.call('history.list', { projectId: s.projectId, repoId: 'nope', branch: 'feat' }), (e) => e.code === 'NOT_FOUND')
  // A server without a history store answers an empty page.
  assert.deepEqual(await s.call('history.list', { projectId: s.projectId, repoId: s.repoId, branch: 'feat' }, { history: undefined }), { events: [], more: false })
})

test('project.delete drops its history', async (t) => {
  const s = await setup(t)
  recordHistory(s.ctx, s.projectId, s.repoId, 'feat', [{ kind: 'created' }])
  recordHistory(s.ctx, s.projectId, 'other-repo', 'feat', [{ kind: 'created' }])
  await s.call('project.delete', { projectId: s.projectId })
  assert.deepEqual(s.history.branch(s.projectId, s.repoId, 'feat'), [])
  assert.deepEqual(s.history.branch(s.projectId, 'other-repo', 'feat'), [])
})

test('the welcome lists the history capability', () => {
  assert.ok(welcomeCapabilities(false).includes('history'))
})

test('branch setters record what changed, with tag names as they were; the same value again records nothing', async (t) => {
  const s = await setup(t)
  s.projects.apply(s.projectId, (d) => {
    d.settings.worktreeTags = [{ id: 'ip', name: 'In Progress', color: '#5dabef' }, { id: 'rv', name: 'Review', color: '#ffaa00' }]
    d.settings.customTags = [{ id: 'bl', name: 'Blocked', color: '#ff0000' }]
  })
  const ref = { projectId: s.projectId, repoId: s.repoId, branch: 'feat' }
  await s.call('branch.setTag', { ...ref, tag: 'ip' })
  await s.call('branch.setTag', { ...ref, tag: 'rv' })
  await s.call('branch.setTag', { ...ref, tag: 'rv' })
  await s.call('branch.setCustomTags', { ...ref, customTags: ['bl'] })
  await s.call('branch.setCustomTags', { ...ref, customTags: null })
  await s.call('branch.setTicket', { ...ref, ticket: 'TOW-1' })
  await s.call('branch.setPr', { ...ref, pr: 'https://github.com/o/r/pull/1' })
  await s.call('branch.setPrWatch', { ...ref, watch: true })
  await s.call('branch.setPr', { ...ref, pr: null })
  await s.call('branch.setEnv', { ...ref, env: 'A=1' })
  assert.deepEqual(s.kinds(), ['prWatch.off', 'pr', 'prWatch.on', 'pr', 'ticket', 'label.removed', 'label.added', 'status', 'status'])
  const status = s.history.list(s.projectId, s.repoId, 'feat').events.find((e) => e.kind === 'status')
  assert.deepEqual([status.from, status.to], [{ id: 'ip', text: 'In Progress', color: '#5dabef' }, { id: 'rv', text: 'Review', color: '#ffaa00' }])
  // Renaming the tag later does not rewrite the past.
  s.projects.apply(s.projectId, (d) => { d.settings.worktreeTags[1].name = 'Renamed' })
  assert.equal(s.history.list(s.projectId, s.repoId, 'feat').events.find((e) => e.kind === 'status').to.text, 'Review')
  assert.ok(s.history.list(s.projectId, s.repoId, 'feat').events.every((e) => e.actor.kind === 'user'))
})

test('setting the same ticket, PR or note again records nothing; the watch toggles record only real changes', async (t) => {
  const s = await setup(t)
  const ref = { projectId: s.projectId, repoId: s.repoId, branch: 'feat' }
  const pr = 'https://github.com/o/r/pull/1'
  await s.call('branch.setTicket', { ...ref, ticket: 'T-1' })
  await s.call('branch.setNote', { ...ref, note: 'n' })
  await s.call('branch.setPr', { ...ref, pr })
  assert.deepEqual(s.kinds(), ['pr', 'note', 'ticket'])
  await s.call('branch.setTicket', { ...ref, ticket: 'T-1' })
  await s.call('branch.setNote', { ...ref, note: 'n' })
  await s.call('branch.setPr', { ...ref, pr })
  assert.deepEqual(s.kinds(), ['pr', 'note', 'ticket'])
  await s.call('branch.setPrWatch', { ...ref, watch: false }) // off while off
  assert.equal(s.kinds().length, 3)
  await s.call('branch.setPrWatch', { ...ref, watch: true })
  await s.call('branch.setPrWatch', { ...ref, watch: true }) // on while on
  assert.equal(s.kinds().length, 4)
  await s.call('branch.setPr', { ...ref, pr }) // same PR keeps the watch
  assert.equal(s.kinds().length, 4)
  await s.call('branch.setPrWatch', { ...ref, watch: false })
  assert.equal(s.kinds()[0], 'prWatch.off')
  assert.equal(s.kinds().length, 5)
})

test('two copies of one label id record one label.added', async (t) => {
  const s = await setup(t)
  s.projects.apply(s.projectId, (d) => { d.settings.customTags = [{ id: 'bl', name: 'Blocked', color: '#ff0000' }] })
  await s.call('branch.setCustomTags', { projectId: s.projectId, repoId: s.repoId, branch: 'feat', customTags: ['bl', 'bl'] })
  assert.deepEqual(s.kinds(), ['label.added'])
})

test('a refused setter records nothing', async (t) => {
  const s = await setup(t)
  const ref = { projectId: s.projectId, repoId: s.repoId, branch: 'feat' }
  await s.call('branch.setNote', { ...ref, note: 'n' })
  await assert.rejects(s.call('branch.setNote', { ...ref, note: 'x', expected: 'stale' }), (e) => e.code === 'CONFLICT')
  await assert.rejects(s.call('branch.setPrWatch', { ...ref, watch: true }), (e) => e.code === 'BAD_REQUEST') // no PR linked
  assert.deepEqual(s.kinds(), ['note'])
})

test('a request attributed to MCP records its actor and reason', async (t) => {
  const s = await setup(t)
  const attribution = { actor: { kind: 'mcp', terminalId: 't1', sessionTitle: 'Claude' }, reason: 'ready for review' }
  await s.call('branch.setTicket', { projectId: s.projectId, repoId: s.repoId, branch: 'feat', ticket: 'TOW-9' }, { attribution })
  const [e] = s.history.list(s.projectId, s.repoId, 'feat').events
  assert.deepEqual([e.actor, e.reason], [attribution.actor, attribution.reason])
})

// The guard: a branch.set* method added later must say what it records (or be listed as recording nothing).
const SETTER_VALUES = {
  'branch.setTag': { tag: 'x' },
  'branch.setCustomTags': { customTags: ['x'] },
  'branch.setNote': { note: 'n' },
  'branch.setTicket': { ticket: 'T-1' },
  'branch.setPr': { pr: 'https://github.com/o/r/pull/1' },
  'branch.setPrWatch': { watch: true }
}
const RECORDS_NOTHING = ['branch.setEnv']

test('every branch.set* method records its change (setEnv excepted)', async (t) => {
  assert.ok(BRANCH_SET_METHODS.includes('branch.setPrWatch') && BRANCH_SET_METHODS.length >= 7)
  for (const method of BRANCH_SET_METHODS) {
    if (RECORDS_NOTHING.includes(method)) continue
    assert.ok(Object.hasOwn(SETTER_VALUES, method), `${method} has no test value: give it one and make it record`)
  }
  const s = await setup(t)
  const ref = { projectId: s.projectId, repoId: s.repoId, branch: 'feat' }
  await s.call('branch.setPr', { ...ref, pr: 'https://github.com/o/r/pull/1' }) // setPrWatch needs a PR
  for (const method of Object.keys(SETTER_VALUES)) {
    const before = s.history.branch(s.projectId, s.repoId, 'feat').length
    if (method === 'branch.setPr') await s.call(method, { ...ref, pr: 'https://github.com/o/r/pull/2' })
    else await s.call(method, { ...ref, ...SETTER_VALUES[method] })
    assert.ok(s.history.branch(s.projectId, s.repoId, 'feat').length > before, `${method} recorded nothing`)
  }
})
