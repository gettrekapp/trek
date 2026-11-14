// scripts/serverHistory.test.mjs — worktree history: what each change records, and history.list.
// Keep a user's global git config and hooks out of the real git these tests run.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore } from '../server/src/history/store.ts'
import { MAX_HISTORY_REASON, MAX_VALUE_TEXT } from '../src/shared/model/history.ts'
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
