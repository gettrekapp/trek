// scripts/teardownPrompt.test.mjs — a server window's teardown confirm (plugins E3): a checkbox per
// item of the server's plan; Confirm waits while a running item is unticked (the move dialog's rule),
// or while a participant the server could not ask is not gone past on purpose; one question at a
// time; one asked by an agent closes by its dialogId.
import test from 'node:test'
import assert from 'node:assert/strict'
import { answerTeardown, cancelTeardown, currentTeardown, requestTeardown, uncheckedName } from '../src/renderer/src/v2/teardownPrompt.ts'
import { teardownBlocking } from '../src/shared/teardown.ts'

const stack = { id: 'stack:destroy', label: 'Tear down the dev stack “trek-r-feat” (drops its databases)', checked: true, running: true }
const vm = { id: 'env:destroy', label: "Stop and delete this worktree's Colima VM “twb-x”", checked: false }
const prompt = { title: 'Delete Worktree', message: 'Delete worktree “feat”?', confirmLabel: 'Delete Worktree' }

test('teardownBlocking: a running item left unticked blocks; a stopped one may stay', () => {
  assert.deepEqual(teardownBlocking([stack, vm], new Set()), ['stack:destroy'])
  assert.deepEqual(teardownBlocking([stack, vm], new Set([stack.id])), [])
  assert.deepEqual(teardownBlocking([vm], new Set()), [])
})

test('requestTeardown: shown until answered; confirmed sends the ticked ids in plan order, refused while one blocks; cancelled sends none', async () => {
  const asked = requestTeardown(prompt, [stack, vm])
  assert.deepEqual([currentTeardown()?.prompt, currentTeardown()?.items, currentTeardown()?.unplanned], [prompt, [stack, vm], []])
  answerTeardown(true, new Set([vm.id]))
  assert.notEqual(currentTeardown(), null, 'the running stack is unticked: still asking')
  answerTeardown(true, new Set([vm.id, stack.id]))
  assert.deepEqual(await asked, { confirmed: true, teardown: ['stack:destroy', 'env:destroy'] })
  assert.equal(currentTeardown(), null)
  const declined = requestTeardown(prompt, [vm])
  answerTeardown(false, new Set([vm.id]))
  assert.deepEqual(await declined, { confirmed: false, teardown: [] })
})

test('a second question cancels the first; cancelTeardown ends any, or only the one with its dialogId', async () => {
  const first = requestTeardown(prompt, [vm])
  const second = requestTeardown({ ...prompt, dialogId: 'promote:r1' }, [vm])
  assert.deepEqual(await first, { confirmed: false, teardown: [] })
  assert.notEqual(currentTeardown().id, undefined)
  let settled = false
  void second.then(() => (settled = true))
  cancelTeardown('promote:other')
  await Promise.resolve()
  assert.equal(settled, false)
  cancelTeardown('promote:r1')
  assert.deepEqual(await second, { confirmed: false, teardown: [] })
  answerTeardown(true, new Set())
  const third = requestTeardown(prompt, [vm])
  cancelTeardown()
  assert.deepEqual(await third, { confirmed: false, teardown: [] })
})

test("a participant the server could not ask (teardownPlan's unplanned) keeps Confirm off until the user goes ahead without it", async () => {
  const asked = requestTeardown(prompt, [stack], ['env'])
  assert.deepEqual(currentTeardown()?.unplanned, ['env'])
  answerTeardown(true, new Set([stack.id]))
  assert.notEqual(currentTeardown(), null, 'not gone past on purpose: still asking')
  answerTeardown(true, new Set([stack.id]), true)
  assert.deepEqual(await asked, { confirmed: true, teardown: ['stack:destroy'] })
  // The running item still blocks when going ahead without the unplanned one.
  const both = requestTeardown(prompt, [stack], ['env'])
  answerTeardown(true, new Set(), true)
  assert.notEqual(currentTeardown(), null)
  cancelTeardown()
  assert.deepEqual(await both, { confirmed: false, teardown: [] })
})

test('uncheckedName: the stack as the move dialog says it; a plugin by its name; an unknown id as it is', () => {
  const names = { env: 'Colima environments' }
  const nameOf = (id) => names[id] ?? id
  assert.deepEqual(['stack', 'env', 'other'].map((id) => uncheckedName(id, nameOf)), ['its dev stack', 'Colima environments', 'other'])
})
