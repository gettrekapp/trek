// scripts/worktreeTeardown.test.mjs — the delete's teardown on the server's machine
// (worktreeTeardown.ts): through the backend doing the remove, the stack's failure note, and the
// fresh dirty check's fallbacks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorktreeTeardown, DIRTY_CHECK_TIMED_OUT } from '../src/renderer/src/worktreeTeardown.ts'

const info = { path: '/r-feat', repoId: 'r1', isMain: false, branch: 'feat', dirty: true }
const coded = (code, message) => Object.assign(new Error(message), { code })

function setup({ partWarnings = [], checkbox = { confirmed: true, checked: true }, items = (all) => ({ confirmed: true, teardown: all.map((i) => i.id) }) } = {}) {
  const ui = []
  const teardown = createWorktreeTeardown({
    pluginPart: (i) => (i.branch === 'feat' ? { notice: 'Its Docker environment (Colima VM “twb-feat-abc123”) and all its data will also be deleted.' } : undefined),
    destroyPluginPart: async (owner, i) => {
      ui.push(['destroy part', owner.name, i.path])
      return partWarnings
    },
    showError: async (title, message) => void ui.push(['error', title, message]),
    confirm: async (prompt) => {
      ui.push(['confirm', prompt.title])
      return true
    },
    confirmWithCheckbox: async (options) => {
      ui.push(['confirm+box', options.checkboxLabel])
      return checkbox
    },
    confirmTeardown: async (prompt, all, unplanned) => {
      ui.push(['confirm+items', prompt.title, all.map((i) => i.id), ...(unplanned.length > 0 ? [unplanned] : [])])
      return items(all)
    }
  })
  return { teardown, ui }
}

/** A backend with only what the teardown calls; `name` tells the owner apart. */
const backendWith = ({ status, destroy, dirty } = {}) => {
  const calls = []
  const answer = (value, ...args) => (typeof value === 'function' ? value(...args) : Promise.resolve(value))
  return {
    name: 'owner',
    calls,
    stacks: {
      status: (loc) => (calls.push(['stack.status', loc.path]), answer(status, loc)),
      destroy: (loc) => (calls.push(['stack.destroy', loc.path]), answer(destroy, loc))
    },
    git: { dirty: (loc) => (calls.push(['worktree.dirty', loc.path]), answer(dirty, loc)) }
  }
}

test('confirm: a stack that has run is offered as the checkbox, asked of the backend doing the remove', async () => {
  const { teardown, ui } = setup()
  const owner = backendWith({ status: { available: true, created: true, slug: 'r-feat' } })
  assert.deepEqual(await teardown.confirm(info, { title: 'Delete Worktree' }, owner), { confirmed: true, stackName: 'r-feat' })
  assert.deepEqual(owner.calls, [['stack.status', '/r-feat']])
  assert.match(ui[0][1], /trek-r-feat/)
  // No stack, or a status that fails: the plain confirm.
  for (const status of [{ available: true, created: false, slug: 'r-feat' }, () => Promise.reject(coded('TOOL_ERROR', 'x'))]) {
    const plain = setup()
    assert.deepEqual(await plain.teardown.confirm(info, { title: 'Delete Worktree' }, backendWith({ status })), { confirmed: true })
    assert.deepEqual(plain.ui, [['confirm', 'Delete Worktree']])
  }
  // The box unticked keeps the stack.
  const unticked = setup({ checkbox: { confirmed: true, checked: false } })
  assert.deepEqual(await unticked.teardown.confirm(info, { title: 'Delete Worktree' }, backendWith({ status: { available: true, created: true, slug: 'r-feat' } })), { confirmed: true, stackName: undefined })
})

test("destroyStack: a non-zero exit or a failure is shown with the server-side command; success shows nothing", async () => {
  const ok = setup()
  await ok.teardown.destroyStack(info, 'r-feat', backendWith({ destroy: 0 }))
  assert.deepEqual(ok.ui, [])
  const exited = setup()
  await exited.teardown.destroyStack(info, 'r-feat', backendWith({ destroy: 2 }))
  assert.equal(exited.ui[0][1], 'Dev stack cleanup failed')
  assert.match(exited.ui[0][2], /^stack\.sh destroy exited with code 2\./)
  assert.match(exited.ui[0][2], /on the server's machine with:\nTREK_STACK_NAME=r-feat docker\/stack\/stack\.sh destroy$/)
  const refused = setup()
  await refused.teardown.destroyStack(info, 'r-feat', backendWith({ destroy: () => Promise.reject(coded('TOOL_ERROR', 'stack r-feat is starting')) }))
  assert.match(refused.ui[0][2], /^Error: stack r-feat is starting\n/)
})

test('destroyStack: a promote says the promote goes on, a delete that the worktree is deleted anyway', async () => {
  const promote = setup()
  await promote.teardown.destroyStack(info, 'r-feat', backendWith({ destroy: 2 }), 'promote')
  assert.match(promote.ui[0][2], /The promote goes on anyway/)
  const remove = setup()
  await remove.teardown.destroyStack(info, 'r-feat', backendWith({ destroy: 2 }))
  assert.match(remove.ui[0][2], /The worktree is deleted anyway/)
})

test("destroyPluginPart: through the backend doing the remove; each plugin's warning is shown, as it says it", async () => {
  const quiet = setup()
  await quiet.teardown.destroyPluginPart(info, backendWith())
  assert.deepEqual(quiet.ui, [['destroy part', 'owner', '/r-feat']])
  const warning = 'Failed to remove environment VM "twb-feat-abc123": boom. It is listed under Orphaned environments in Settings.'
  const warned = setup({ partWarnings: [warning] })
  await warned.teardown.destroyPluginPart(info, backendWith())
  assert.deepEqual(warned.ui.at(-1), ['error', 'Cleanup failed', warning])
})

test("isDirty: the server's answer; null or a failure falls back to the cached flag; a timeout stops the delete", async () => {
  const { teardown } = setup()
  assert.equal(await teardown.isDirty({ ...info, dirty: true }, backendWith({ dirty: false })), false)
  assert.equal(await teardown.isDirty({ ...info, dirty: false }, backendWith({ dirty: true })), true)
  assert.equal(await teardown.isDirty({ ...info, dirty: true }, backendWith({ dirty: null })), true)
  assert.equal(await teardown.isDirty({ ...info, dirty: undefined }, backendWith({ dirty: null })), false)
  // A server older than worktree.dirty, or git that cannot read it (Decision 13).
  assert.equal(await teardown.isDirty({ ...info, dirty: false }, backendWith({ dirty: () => Promise.reject(coded('UNKNOWN_METHOD', 'no')) })), false)
  // A timeout says nothing about the worktree: no guess of "clean" before the stack and the VM go.
  await assert.rejects(
    teardown.isDirty({ ...info, dirty: false }, backendWith({ dirty: () => Promise.reject(coded('TIMEOUT', 'worktree.dirty timed out')) })),
    (err) => err.message === DIRTY_CHECK_TIMED_OUT
  )
})

test('confirm: an agent request that ended while the stack status was read shows no dialog (5e, M4)', async () => {
  const { teardown, ui } = setup()
  let wanted = true
  const owner = backendWith({ status: () => { wanted = false; return Promise.resolve({ available: true, created: true, slug: 'r-feat' }) } })
  assert.deepEqual(await teardown.confirm(info, { title: 'Promote to Primary' }, owner, () => wanted), { confirmed: false })
  assert.deepEqual(ui, [])
})

test("confirmPlan (plugins E1, E3): no items is the plain confirm; with items the window's own confirm, a box per item, sends what it answers", async () => {
  const stack = { id: 'stack:destroy', label: 'Tear down the dev stack “trek-r-feat” (drops its databases)', checked: true }
  const vm = { id: 'env:destroy', label: "Stop and delete this worktree's Colima VM “twb-x”", checked: false }
  const plain = setup()
  assert.deepEqual(await plain.teardown.confirmPlan({ title: 'Delete Worktree' }, []), { confirmed: true, teardown: [] })
  assert.deepEqual(plain.ui, [['confirm', 'Delete Worktree']])
  const several = setup({ items: () => ({ confirmed: true, teardown: ['env:destroy'] }) })
  assert.deepEqual(await several.teardown.confirmPlan({ title: 'Delete Worktree' }, [stack, vm]), { confirmed: true, teardown: ['env:destroy'] })
  assert.deepEqual(several.ui, [['confirm+items', 'Delete Worktree', ['stack:destroy', 'env:destroy']]])
  const declined = setup({ items: () => ({ confirmed: false, teardown: [] }) })
  assert.deepEqual(await declined.teardown.confirmPlan({ title: 'Delete Worktree' }, [stack]), { confirmed: false, teardown: [] })
  const ended = setup()
  assert.deepEqual(await ended.teardown.confirmPlan({ title: 'Promote to Primary' }, [stack], () => false), { confirmed: false, teardown: [] })
  assert.deepEqual(ended.ui, [])
})

test('confirmPlan (plugins E3): the participants the server could not ask go to the window\'s confirm, even with no items', async () => {
  const stack = { id: 'stack:destroy', label: 'Tear down the dev stack “trek-r-feat” (drops its databases)', checked: true }
  const withItems = setup()
  await withItems.teardown.confirmPlan({ title: 'Delete Worktree' }, [stack], undefined, ['env'])
  assert.deepEqual(withItems.ui, [['confirm+items', 'Delete Worktree', ['stack:destroy'], ['env']]])
  const none = setup()
  assert.deepEqual(await none.teardown.confirmPlan({ title: 'Delete Worktree' }, [], undefined, ['env']), { confirmed: true, teardown: [] })
  assert.deepEqual(none.ui, [['confirm+items', 'Delete Worktree', [], ['env']]])
})
