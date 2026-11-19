// scripts/teardownPrompt.test.mjs — a server window's teardown confirm (plugins E3): a checkbox per
// item of the server's plan; Confirm waits while a running item is unticked (the move dialog's rule),
// or while a participant the server could not ask is not gone past on purpose; questions queue; one
// asked by an agent closes by its dialogId, shown or queued; nothing shows without a prompt mounted.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  answerTeardown,
  cancelTeardown,
  currentTeardown,
  hostTeardownPrompt,
  requestTeardown,
  uncheckedName,
  uncheckedText
} from '../src/renderer/src/v2/teardownPrompt.ts'
import { teardownBlocking } from '../src/shared/teardown.ts'

const stack = { id: 'stack:destroy', label: 'Tear down the dev stack “trek-r-feat” (drops its databases)', checked: true, running: true }
const vm = { id: 'env:destroy', label: "Stop and delete this worktree's Colima VM “twb-x”", checked: false }
const prompt = { title: 'Delete Worktree', message: 'Delete worktree “feat”?', confirmLabel: 'Delete Worktree' }

let unhost = () => {}
test.beforeEach(() => {
  cancelTeardown()
  unhost = hostTeardownPrompt()
})
test.afterEach(() => {
  cancelTeardown()
  unhost()
})

const shownId = () => currentTeardown()?.id

test('teardownBlocking: a running item left unticked blocks; a stopped one may stay', () => {
  assert.deepEqual(teardownBlocking([stack, vm], new Set()), ['stack:destroy'])
  assert.deepEqual(teardownBlocking([stack, vm], new Set([stack.id])), [])
  assert.deepEqual(teardownBlocking([vm], new Set()), [])
})

test('requestTeardown: shown until answered; confirmed sends the ticked ids in plan order, refused while one blocks; cancelled sends none', async () => {
  const asked = requestTeardown(prompt, [stack, vm])
  assert.deepEqual([currentTeardown()?.prompt, currentTeardown()?.items, currentTeardown()?.unplanned], [prompt, [stack, vm], []])
  const id = shownId()
  answerTeardown(id, true, new Set([vm.id]))
  assert.notEqual(currentTeardown(), null, 'the running stack is unticked: still asking')
  answerTeardown(id, true, new Set([vm.id, stack.id]))
  assert.deepEqual(await asked, { confirmed: true, teardown: ['stack:destroy', 'env:destroy'] })
  assert.equal(currentTeardown(), null)
  const declined = requestTeardown(prompt, [vm])
  answerTeardown(shownId(), false, new Set([vm.id]))
  assert.deepEqual(await declined, { confirmed: false, teardown: [] })
  // No question: an answer does nothing.
  answerTeardown(id, true, new Set())
  assert.equal(currentTeardown(), null)
})

test("questions queue: an agent's request waits behind the user's delete; an answer naming another question does nothing", async () => {
  const mine = requestTeardown(prompt, [vm])
  const agents = requestTeardown({ ...prompt, title: 'Promote to Primary', dialogId: 'promote:r1' }, [vm])
  const first = shownId()
  assert.equal(currentTeardown()?.prompt.title, 'Delete Worktree', 'the first asked is shown')
  answerTeardown(first + 1, false, new Set())
  assert.equal(shownId(), first, 'not the shown one: nothing')
  answerTeardown(first, true, new Set([vm.id]))
  assert.deepEqual(await mine, { confirmed: true, teardown: ['env:destroy'] })
  assert.equal(currentTeardown()?.prompt.title, 'Promote to Primary', 'then the next')
  answerTeardown(first, true, new Set([vm.id]))
  assert.equal(currentTeardown()?.prompt.title, 'Promote to Primary', "the first one's id no longer answers")
  answerTeardown(shownId(), true, new Set())
  assert.deepEqual(await agents, { confirmed: true, teardown: [] })
  assert.equal(currentTeardown(), null)
})

test('cancelTeardown: by dialogId, the shown one or a queued one, others stay; with none, every one', async () => {
  const mine = requestTeardown(prompt, [vm])
  const agents = requestTeardown({ ...prompt, dialogId: 'promote:r1' }, [vm])
  let settled = false
  void mine.then(() => (settled = true))
  cancelTeardown('promote:other')
  cancelTeardown('promote:r1')
  assert.deepEqual(await agents, { confirmed: false, teardown: [] }, 'the queued one is gone')
  await Promise.resolve()
  assert.equal(settled, false, "the user's own stays shown")
  assert.equal(currentTeardown()?.prompt.dialogId, undefined)
  const shown = requestTeardown({ ...prompt, dialogId: 'promote:r2' }, [vm])
  answerTeardown(shownId(), true, new Set())
  assert.deepEqual(await mine, { confirmed: true, teardown: [] })
  cancelTeardown('promote:r2')
  assert.deepEqual(await shown, { confirmed: false, teardown: [] }, 'the shown one goes too')
  assert.equal(currentTeardown(), null)
  const a = requestTeardown(prompt, [vm])
  const b = requestTeardown(prompt, [vm])
  cancelTeardown()
  assert.deepEqual(await Promise.all([a, b]), [{ confirmed: false, teardown: [] }, { confirmed: false, teardown: [] }])
  assert.equal(currentTeardown(), null)
})

test('with no prompt mounted a question is cancelled at once; queued ones stay across an unmount', async () => {
  const queued = requestTeardown(prompt, [vm])
  unhost()
  assert.deepEqual(await requestTeardown(prompt, [vm]), { confirmed: false, teardown: [] })
  assert.notEqual(currentTeardown(), null, 'shown again once a prompt mounts')
  unhost = hostTeardownPrompt()
  answerTeardown(shownId(), false, new Set())
  assert.deepEqual(await queued, { confirmed: false, teardown: [] })
})

test("a participant the server could not ask (teardownPlan's unplanned) keeps Confirm off until the user goes ahead without it", async () => {
  const asked = requestTeardown(prompt, [stack], ['env'])
  assert.deepEqual(currentTeardown()?.unplanned, ['env'])
  answerTeardown(shownId(), true, new Set([stack.id]))
  assert.notEqual(currentTeardown(), null, 'not gone past on purpose: still asking')
  answerTeardown(shownId(), true, new Set([stack.id]), true)
  assert.deepEqual(await asked, { confirmed: true, teardown: ['stack:destroy'] })
  // The running item still blocks when going ahead without the unplanned one.
  const both = requestTeardown(prompt, [stack], ['env'])
  answerTeardown(shownId(), true, new Set(), true)
  assert.notEqual(currentTeardown(), null)
  cancelTeardown()
  assert.deepEqual(await both, { confirmed: false, teardown: [] })
})

test('uncheckedName and uncheckedText: the stack as the move dialog says it; a plugin by its name; an unknown id as it is', () => {
  const names = { env: 'Colima environments' }
  const nameOf = (id) => names[id] ?? id
  assert.deepEqual(['stack', 'env', 'other'].map((id) => uncheckedName(id, nameOf)), ['its dev stack', 'Colima environments', 'other'])
  assert.equal(uncheckedText([], nameOf), '')
  assert.equal(uncheckedText(['env'], nameOf), 'This server could not check Colima environments, so it may be left running. Cancel and try again, or go ahead without it.')
  assert.equal(
    uncheckedText(['stack', 'env'], nameOf),
    'This server could not check its dev stack and Colima environments, so they may be left running. Cancel and try again, or go ahead without them.'
  )
})
