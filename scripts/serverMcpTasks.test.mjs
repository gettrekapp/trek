// scripts/serverMcpTasks.test.mjs — tasks as the trek-dev tools see them (server/src/mcp/tasks.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeTask, listTasks, resolveTask, taskSaveInput } from '../server/src/mcp/tasks.ts'

const T = Date.UTC(2026, 0, 5, 12)
const task = (over = {}) => ({ id: 't1', title: 'Fix it', createdAt: T, updatedAt: T, ...over })
const project = (tasks) => ({ id: 'p', name: 'P', settings: {}, repositories: [], globalSessions: [], tasks })

test('describeTask: the short form for lists, the full one with details and starts', () => {
  const t = task({ status: 'waiting', details: 'd', completedAt: T, starts: [{ at: T, repositoryId: 'r', worktreeId: 'w', branch: 'task/fix-it', sessionId: 's' }] })
  assert.deepEqual(describeTask(t, false), {
    id: 't1', title: 'Fix it', status: 'waiting', createdAt: '2026-01-05T12:00:00.000Z', updatedAt: '2026-01-05T12:00:00.000Z', completedAt: '2026-01-05T12:00:00.000Z', startCount: 1
  })
  assert.deepEqual(describeTask(t, true).starts, [{ at: '2026-01-05T12:00:00.000Z', repositoryId: 'r', worktreeId: 'w', branch: 'task/fix-it', terminalId: 's' }])
  assert.equal(describeTask(t, true).details, 'd')
})

test('listTasks filters: open (default), completed, archived, all; a bad filter is BAD_REQUEST', () => {
  const p = project([task({ id: 'o' }), task({ id: 'c', completedAt: T }), task({ id: 'a', archivedAt: T }), task({ id: 'ca', completedAt: T, archivedAt: T })])
  const ids = (filter) => listTasks(p, filter).map((t) => t.id)
  assert.deepEqual(ids(undefined), ['o'])
  assert.deepEqual(ids('completed'), ['c'])
  assert.deepEqual(ids('archived'), ['a', 'ca'])
  assert.deepEqual(ids('all'), ['o', 'c', 'a', 'ca'])
  assert.throws(() => listTasks(p, 'done'), (e) => e.code === 'BAD_REQUEST')
  assert.deepEqual(listTasks(project(undefined), 'all'), [])
})

test('resolveTask: id first, then title (trimmed, case-insensitive); ambiguous and unknown', () => {
  const p = project([task(), task({ id: 't2', title: 'Ship' }), task({ id: 't3', title: 'Ship' })])
  assert.equal(resolveTask(p, ' t1 ').id, 't1')
  assert.equal(resolveTask(p, ' fix IT ').id, 't1')
  assert.throws(() => resolveTask(p, 'ship'), (e) => e.code === 'BAD_REQUEST' && e.message.includes('t2, t3'))
  assert.throws(() => resolveTask(p, 'nope'), (e) => e.code === 'NOT_FOUND' && e.message.includes('Fix it'))
  assert.throws(() => resolveTask(project(undefined), 'nope'), (e) => e.code === 'NOT_FOUND' && e.message.includes('it has none'))
  assert.throws(() => resolveTask(p, ''), (e) => e.code === 'BAD_REQUEST')
})

test('taskSaveInput: create needs a title; an update keeps absent fields; "" clears', () => {
  assert.deepEqual(taskSaveInput(undefined, { title: 'New', status: 's' }), { title: 'New', status: 's' })
  assert.throws(() => taskSaveInput(undefined, { details: 'x' }), (e) => e.code === 'BAD_REQUEST' && /title is required/.test(e.message))
  const existing = task({ details: 'd', status: 's' })
  assert.deepEqual(taskSaveInput(existing, { status: 'blocked' }), { id: 't1', title: 'Fix it', details: 'd', status: 'blocked' })
  assert.deepEqual(taskSaveInput(existing, { details: '' }), { id: 't1', title: 'Fix it', details: '', status: 's' })
})
