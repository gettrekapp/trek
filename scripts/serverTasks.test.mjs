// scripts/serverTasks.test.mjs — tasks on the server: the input checks and mutations (server/src/tasks/model.ts)
// and the task.* v2 methods other than task.start (server/src/tasks/taskHandlers.ts; task.start is in serverTaskStart.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkTaskInput, deleteTask, findTask, recordTaskStart, reorderTasks, requireTasksOn, saveTask, setTaskArchived, setTaskCompleted
} from '../server/src/tasks/model.ts'
import { MAX_TASKS } from '../src/shared/tasks.ts'

const code = (fn) => {
  try {
    fn()
    return 'ok'
  } catch (err) {
    return err.code
  }
}
let n = 0
const newId = () => `t${++n}`
const task = (over = {}) => ({ id: 't', title: 'Fix it', createdAt: 1, updatedAt: 1, ...over })

test('checkTaskInput trims and keeps empty details/status as empty strings', () => {
  assert.deepEqual(checkTaskInput({ title: '  Fix it ', details: ' d ', status: ' s ' }), { title: 'Fix it', details: 'd', status: 's' })
  assert.deepEqual(checkTaskInput({ id: 'x', title: 'T' }), { id: 'x', title: 'T', details: '', status: '' })
})

test('checkTaskInput refuses bad input with BAD_REQUEST', () => {
  for (const bad of [
    null,
    { title: '' },
    { title: '   ' },
    { title: 'x'.repeat(201) },
    { title: 'two\nlines' },
    { title: 'T', details: 7 },
    { title: 'T', details: 'x'.repeat(20_001) },
    { title: 'T', details: 'bell\u0007' },
    { title: 'T', status: 'x'.repeat(81) },
    { title: 'T', status: 'a\nb' },
    { title: 'T', id: 7 },
    { title: 'T', id: '' },
    { title: 'line\u2028separator' },
    { title: 'para\u2029separator' },
    { title: 'T', status: 'a\u2028b' }
  ]) {
    assert.equal(code(() => checkTaskInput(bad)), 'BAD_REQUEST', JSON.stringify(bad))
  }
  assert.equal(code(() => checkTaskInput({ title: 'T', details: 'line\nline\ttab' })), 'ok')
})

test('checkTaskInput: null details or status means clear, as empty or absent does', () => {
  assert.deepEqual(checkTaskInput({ title: 'T', details: null, status: null }), { title: 'T', details: '', status: '' })
  const { list } = saveTask([task({ details: 'd', status: 's' })], checkTaskInput({ id: 't', title: 'T', details: null, status: null }), 5, newId)
  assert.deepEqual(['details' in list[0], 'status' in list[0]], [false, false])
})

test('saveTask creates at the end with createdAt = updatedAt = now; empty fields are absent', () => {
  const { list, id, updatedAt } = saveTask([task()], checkTaskInput({ title: 'New', details: '', status: 'waiting' }), 50, newId)
  assert.equal(updatedAt, 50)
  assert.deepEqual(list[1], { id, title: 'New', status: 'waiting', createdAt: 50, updatedAt: 50 })
})

test('saveTask updates, clears empty fields, and bumps updatedAt even within one millisecond', () => {
  const before = task({ details: 'd', status: 's', updatedAt: 100 })
  const { list, updatedAt } = saveTask([before], checkTaskInput({ id: 't', title: 'Renamed' }), 100, newId)
  assert.deepEqual(list[0], { id: 't', title: 'Renamed', createdAt: 1, updatedAt: 101 })
  assert.equal(updatedAt, 101)
  // A clock behind the stored time still moves updatedAt forward.
  assert.equal(saveTask([task({ updatedAt: 100 })], checkTaskInput({ id: 't', title: 'x' }), 40, newId).updatedAt, 101)
})

test('saveTask: a create ignores expectedUpdatedAt', () => {
  const { list, updatedAt } = saveTask([], checkTaskInput({ title: 'New' }), 7, newId, 123)
  assert.deepEqual([list.length, updatedAt], [1, 7])
})

test('saveTask: a stale expectedUpdatedAt is CONFLICT; a matching one saves; unknown id NOT_FOUND', () => {
  const list = [task({ updatedAt: 5 })]
  assert.equal(code(() => saveTask(list, checkTaskInput({ id: 't', title: 'x' }), 9, newId, 4)), 'CONFLICT')
  assert.equal(code(() => saveTask(list, checkTaskInput({ id: 't', title: 'x' }), 9, newId, 5)), 'ok')
  assert.equal(code(() => saveTask(list, checkTaskInput({ id: 'zz', title: 'x' }), 9, newId)), 'NOT_FOUND')
})

test('saveTask: at most MAX_TASKS, archived ones included', () => {
  const full = Array.from({ length: MAX_TASKS }, (_, i) => task({ id: `t${i}`, archivedAt: 1 }))
  assert.equal(code(() => saveTask(full, checkTaskInput({ title: 'one more' }), 9, newId)), 'CAPACITY')
})

test('setTaskCompleted and setTaskArchived set and clear their time and bump updatedAt', () => {
  let list = setTaskCompleted([task()], 't', true, 10)
  assert.deepEqual([list[0].completedAt, list[0].updatedAt], [10, 10])
  list = setTaskCompleted(list, 't', true, 20)
  assert.equal(list[0].completedAt, 10, 'completing again keeps the first time')
  list = setTaskCompleted(list, 't', false, 30)
  assert.equal('completedAt' in list[0], false)
  list = setTaskArchived(list, 't', true, 40)
  assert.equal(list[0].archivedAt, 40)
  list = setTaskArchived(list, 't', false, 50)
  assert.deepEqual(['archivedAt' in list[0], list[0].updatedAt], [false, 50])
  assert.equal(code(() => setTaskCompleted(list, 'zz', true, 1)), 'NOT_FOUND')
})

test('setTaskCompleted and setTaskArchived: the value a task already has changes nothing (same list, same updatedAt)', () => {
  const done = [task({ completedAt: 10, updatedAt: 10 })]
  assert.equal(setTaskCompleted(done, 't', true, 20), done)
  const open = [task({ updatedAt: 10 })]
  assert.equal(setTaskCompleted(open, 't', false, 20), open)
  assert.equal(setTaskArchived(open, 't', false, 20), open)
  const archived = [task({ archivedAt: 40, updatedAt: 40 })]
  assert.equal(setTaskArchived(archived, 't', true, 50), archived)
  assert.deepEqual([archived[0].archivedAt, archived[0].updatedAt], [40, 40], 'archiving again keeps the first time')
})

test('deleteTask: archived only', () => {
  assert.equal(code(() => deleteTask([task()], 't')), 'BAD_REQUEST')
  assert.deepEqual(deleteTask([task({ archivedAt: 1 }), task({ id: 'u' })], 't'), [task({ id: 'u' })])
  assert.equal(code(() => deleteTask([], 't')), 'NOT_FOUND')
})

test('reorderTasks: a permutation of every id', () => {
  const list = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]
  assert.deepEqual(reorderTasks(list, ['c', 'a', 'b']).map((t) => t.id), ['c', 'a', 'b'])
  for (const bad of [['a', 'b'], ['a', 'b', 'c', 'd'], ['a', 'a', 'b'], ['a', 'b', 'x'], 'abc', [1, 2, 3]]) {
    assert.equal(code(() => reorderTasks(list, bad)), 'BAD_REQUEST', JSON.stringify(bad))
  }
  // A stored list with a repeated id cannot be reordered into one without it.
  assert.equal(code(() => reorderTasks([task({ id: 'a' }), task({ id: 'a' })], ['a', 'b'])), 'BAD_REQUEST')
  assert.equal(code(() => reorderTasks([task({ id: 'a' }), task({ id: 'a' }), task({ id: 'b' })], ['a', 'b', 'c'])), 'BAD_REQUEST')
})

test('recordTaskStart appends, keeps the newest 20, and bumps updatedAt', () => {
  const start = (i) => ({ at: i, repositoryId: 'r', worktreeId: `w${i}`, branch: `task/x-${i}`, sessionId: `s${i}` })
  let list = [task({ starts: Array.from({ length: 20 }, (_, i) => start(i)) })]
  list = recordTaskStart(list, 't', start(99), 99)
  assert.equal(list[0].starts.length, 20)
  assert.deepEqual([list[0].starts[0].at, list[0].starts[19].at, list[0].updatedAt], [1, 99, 99])
  // A task with no starts yet gets its first; an unknown id is NOT_FOUND.
  assert.deepEqual(recordTaskStart([task()], 't', start(5), 5)[0].starts, [start(5)])
  assert.equal(code(() => recordTaskStart([task()], 'zz', start(5), 5)), 'NOT_FOUND')
})

test('findTask and requireTasksOn', () => {
  assert.equal(findTask([task()], 't').title, 'Fix it')
  assert.equal(code(() => findTask([], 't')), 'NOT_FOUND')
  assert.equal(code(() => requireTasksOn({ settings: {} })), 'ok')
  assert.equal(code(() => requireTasksOn({ settings: { tasksEnabled: true } })), 'ok')
  assert.equal(code(() => requireTasksOn({ settings: { tasksEnabled: false } })), 'TOOL_ERROR')
})

import { TopicHub } from '../server/src/topicHub.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { welcomeCapabilities } from '../server/src/capabilities.ts'

function setupV2(tasks, settings = {}) {
  const hub = new TopicHub()
  const project = { id: 'p1', name: 'Demo', settings, globalSessions: [], repositories: [{ id: 'r1', name: 'app', path: '/repo', branchData: {}, worktrees: [] }], ...(tasks ? { tasks } : {}) }
  const projects = new ProjectState({ hub, store: { save() {}, remove() {} }, onSummariesChange() {} }, [project])
  const call = (method, params) => dispatchV2(method, { projectId: 'p1', ...params }, { hub, projects, sessions: { refreshAttention() {} } })
  const list = () => projects.require('p1').tasks
  return { projects, call, list }
}

test('welcome lists tasks', () => {
  assert.ok(welcomeCapabilities(false).includes('tasks'))
})

test('task.save creates and updates; CONFLICT on a stale expectedUpdatedAt; bad input BAD_REQUEST', () => {
  const v = setupV2()
  const created = v.call('task.save', { task: { title: 'Fix it' } })
  assert.equal(created.ok, true, JSON.stringify(created))
  const { id, updatedAt } = created.result
  assert.deepEqual(v.list().map((t) => [t.id, t.title]), [[id, 'Fix it']])
  assert.equal(v.call('task.save', { task: { id, title: 'Renamed', status: 'waiting' }, expectedUpdatedAt: updatedAt }).ok, true)
  assert.deepEqual([v.list()[0].title, v.list()[0].status], ['Renamed', 'waiting'])
  assert.equal(v.call('task.save', { task: { id, title: 'Again' }, expectedUpdatedAt: updatedAt }).error.code, 'CONFLICT')
  assert.equal(v.call('task.save', { task: { id, title: 'x' }, expectedUpdatedAt: 'soon' }).error.code, 'BAD_REQUEST')
  assert.equal(v.call('task.save', { task: { title: '' } }).error.code, 'BAD_REQUEST')
  assert.equal(v.call('task.save', { projectId: 'nope', task: { title: 'x' } }).error.code, 'NOT_FOUND')
})

test('task.setCompleted, task.setArchived, task.delete, task.reorder', () => {
  const v = setupV2([task({ id: 'a' }), task({ id: 'b' })])
  assert.deepEqual(v.call('task.setCompleted', { taskId: 'a', completed: true }), { ok: true, result: null })
  assert.equal(typeof v.list()[0].completedAt, 'number')
  assert.equal(v.call('task.setCompleted', { taskId: 'a', completed: 'yes' }).error.code, 'BAD_REQUEST')
  assert.equal(v.call('task.delete', { taskId: 'a' }).error.code, 'BAD_REQUEST', 'not archived yet')
  v.call('task.setArchived', { taskId: 'a', archived: true })
  assert.equal(v.call('task.reorder', { taskIds: ['b', 'a'] }).ok, true)
  assert.deepEqual(v.list().map((t) => t.id), ['b', 'a'])
  assert.deepEqual(v.call('task.delete', { taskId: 'a' }), { ok: true, result: null })
  v.call('task.setArchived', { taskId: 'b', archived: true })
  v.call('task.delete', { taskId: 'b' })
  assert.equal(v.list(), undefined, 'the last task gone removes the field')
  assert.equal(v.call('task.setArchived', { taskId: 'zz', archived: true }).error.code, 'NOT_FOUND')
})

test('task.setCompleted on an already-completed task keeps its updatedAt and publishes nothing', () => {
  const v = setupV2([task({ id: 'a', completedAt: 5, updatedAt: 5 })])
  const before = v.projects.require('p1')
  assert.deepEqual(v.call('task.setCompleted', { taskId: 'a', completed: true }), { ok: true, result: null })
  assert.equal(v.list()[0].updatedAt, 5)
  assert.equal(v.projects.require('p1'), before, 'the project was not replaced')
})

test('every task method refuses while Tasks is off', () => {
  const v = setupV2([task({ id: 'a', archivedAt: 1 })], { tasksEnabled: false })
  for (const [method, params] of [
    ['task.save', { task: { title: 'x' } }],
    ['task.setCompleted', { taskId: 'a', completed: true }],
    ['task.setArchived', { taskId: 'a', archived: false }],
    ['task.delete', { taskId: 'a' }],
    ['task.reorder', { taskIds: ['a'] }]
  ]) {
    const res = v.call(method, params)
    assert.equal(res.error?.code, 'TOOL_ERROR', method)
    assert.match(res.error.message, /turned off/)
  }
})

test('project.updateSettings takes tasksEnabled as a boolean', () => {
  const v = setupV2()
  assert.equal(v.call('project.updateSettings', { settings: { tasksEnabled: false } }).ok, true)
  assert.equal(v.projects.require('p1').settings.tasksEnabled, false)
  assert.equal(v.call('project.updateSettings', { settings: { tasksEnabled: 'no' } }).error.code, 'BAD_REQUEST')
})
