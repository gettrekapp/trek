// scripts/tasksUi.test.mjs — the Tasks page's pure helpers (src/renderer/src/tasks.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { groupTasks, moveTask, nextSelection, openTaskCount, startTime, taskCountLine, visibleTaskIds } from '../src/renderer/src/tasks.ts'

const t = (id, over = {}) => ({ id, title: id, createdAt: 0, updatedAt: 0, ...over })
const tasks = [t('a'), t('b', { completedAt: 1 }), t('c', { archivedAt: 1 }), t('d'), t('e', { completedAt: 1, archivedAt: 2 })]

test('groupTasks: open, completed (not archived), archived; in list order', () => {
  const g = groupTasks(tasks)
  assert.deepEqual([g.open.map((x) => x.id), g.completed.map((x) => x.id), g.archived.map((x) => x.id)], [['a', 'd'], ['b'], ['c', 'e']])
  assert.equal(openTaskCount(tasks), 2)
  assert.equal(openTaskCount(undefined), 0)
})

test('taskCountLine', () => {
  assert.equal(taskCountLine(groupTasks(tasks)), '2 open · 1 completed · 2 archived')
  assert.equal(taskCountLine(groupTasks([t('a')])), '1 open')
  assert.equal(taskCountLine(groupTasks([])), '0 open')
})

test('visibleTaskIds: completed when expanded, archived when shown', () => {
  const g = groupTasks(tasks)
  assert.deepEqual(visibleTaskIds(g, false, false), ['a', 'd'])
  assert.deepEqual(visibleTaskIds(g, true, true), ['a', 'd', 'b', 'c', 'e'])
})

test('nextSelection: keeps the chosen one; else the row now at its old place; else the first', () => {
  assert.equal(nextSelection(['a', 'b', 'c'], 'b', 1), 'b')
  assert.equal(nextSelection(['a', 'c'], 'b', 1), 'c')
  assert.equal(nextSelection(['a'], 'b', 1), 'a')
  assert.equal(nextSelection(['a', 'c'], null, -1), 'a')
  assert.equal(nextSelection([], 'b', 0), undefined)
})

test('moveTask: moves one id to an index among the others', () => {
  assert.deepEqual(moveTask(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveTask(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b'])
  assert.deepEqual(moveTask(['a', 'b'], 'zz', 0), ['a', 'b'])
  assert.deepEqual(moveTask(['a', 'b'], 'a', 9), ['b', 'a'], 'clamped')
})

test('startTime: minutes, hours, days ago', () => {
  const now = 10 * 86_400_000
  assert.equal(startTime(now - 30_000, now), 'just now')
  assert.equal(startTime(now - 5 * 60_000, now), '5 min ago')
  assert.equal(startTime(now - 3 * 3_600_000, now), '3 h ago')
  assert.equal(startTime(now - 2 * 86_400_000, now), '2 days ago')
  assert.equal(startTime(now - 86_400_000, now), '1 day ago')
})
