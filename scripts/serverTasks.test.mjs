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
    { title: 'T', id: '' }
  ]) {
    assert.equal(code(() => checkTaskInput(bad)), 'BAD_REQUEST', JSON.stringify(bad))
  }
  assert.equal(code(() => checkTaskInput({ title: 'T', details: 'line\nline\ttab' })), 'ok')
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
})

test('recordTaskStart appends, keeps the newest 20, and bumps updatedAt', () => {
  const start = (i) => ({ at: i, repositoryId: 'r', worktreeId: `w${i}`, branch: `task/x-${i}`, sessionId: `s${i}` })
  let list = [task({ starts: Array.from({ length: 20 }, (_, i) => start(i)) })]
  list = recordTaskStart(list, 't', start(99), 99)
  assert.equal(list[0].starts.length, 20)
  assert.deepEqual([list[0].starts[0].at, list[0].starts[19].at, list[0].updatedAt], [1, 99, 99])
})

test('findTask and requireTasksOn', () => {
  assert.equal(findTask([task()], 't').title, 'Fix it')
  assert.equal(code(() => findTask([], 't')), 'NOT_FOUND')
  assert.equal(code(() => requireTasksOn({ settings: {} })), 'ok')
  assert.equal(code(() => requireTasksOn({ settings: { tasksEnabled: true } })), 'ok')
  assert.equal(code(() => requireTasksOn({ settings: { tasksEnabled: false } })), 'TOOL_ERROR')
})
