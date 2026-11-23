// scripts/tasksShared.test.mjs — the Tasks helpers both the server and the renderer use (src/shared/tasks.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { isOpenTask, slugifyTaskTitle, taskBranchName, taskPrompt } from '../src/shared/tasks.ts'

test('slugifyTaskTitle: lower case, runs of anything else become one dash, trimmed', () => {
  assert.equal(slugifyTaskTitle('Fix the Login Bug!'), 'fix-the-login-bug')
  assert.equal(slugifyTaskTitle('  --Café  déjà vu-- '), 'cafe-deja-vu')
  assert.equal(slugifyTaskTitle('a/b..c'), 'a-b-c')
})

test('slugifyTaskTitle: at most 40 characters, no trailing dash after the cut', () => {
  const slug = slugifyTaskTitle('word '.repeat(20))
  assert.ok(slug.length <= 40)
  assert.equal(slug.endsWith('-'), false)
})

test('slugifyTaskTitle: "task" when nothing usable is left', () => {
  assert.equal(slugifyTaskTitle('!!!'), 'task')
  assert.equal(slugifyTaskTitle('日本語'), 'task')
})

test('taskBranchName: task/<slug>, then -2, -3 …', () => {
  assert.equal(taskBranchName('fix-it', 1), 'task/fix-it')
  assert.equal(taskBranchName('fix-it', 2), 'task/fix-it-2')
})

test('taskPrompt: title, details when present, then the Trek line', () => {
  assert.equal(
    taskPrompt({ id: 't1', title: 'Fix it', details: 'Steps:\n1. a' }),
    'Fix it\n\nSteps:\n1. a\n\nThis is Trek task t1 ("Fix it"). Use the get_task tool to reread it and complete_task when it\'s done.'
  )
  assert.equal(taskPrompt({ id: 't2', title: 'Only' }).startsWith('Only\n\nThis is Trek task t2'), true)
})

test('isOpenTask: neither completed nor archived', () => {
  assert.equal(isOpenTask({ completedAt: undefined, archivedAt: undefined }), true)
  assert.equal(isOpenTask({ completedAt: 1 }), false)
  assert.equal(isOpenTask({ archivedAt: 1 }), false)
})
