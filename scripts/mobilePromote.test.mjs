// scripts/mobilePromote.test.mjs — the phone's own promote and demote (apps/mobile/src/logic/promote.ts):
// the dry run, the server's teardown plan (or an older server's blocker), the question, the request.
import test from 'node:test'
import assert from 'node:assert/strict'
import { demoteBranch, errorCode, promoteWorktree } from '../apps/mobile/src/logic/promote.ts'

const plan = (extra = {}) => ({
  branch: 'feat', mainPath: '/r', worktreePath: '/r-feat', mainBranch: 'main', dirty: false, loaded: false, otherLoaded: false,
  sessions: [], reviewComments: 0, reviewCarried: false, ignored: [], ignoredCount: 0, hiddenChanges: [], hiddenChangesCount: 0, mainIgnored: [], mainIgnoredCount: 0, overwrittenIgnored: [], overwrittenIgnoredCount: 0, ...extra
})
const result = (extra = {}) => ({ worktreeId: 'main-id', moved: [], notes: [], ...extra })
const coded = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) })
const rejects = (error) => () => {
  throw error
}

/** Deps that record their calls; a value in `over` is returned, a function is called. */
function flow(over = {}) {
  const calls = []
  const questions = []
  const step = (name, value) => async (...args) => {
    calls.push(name === 'promote' ? `promote(${args[0].join(',')})` : name)
    return typeof value === 'function' ? value(...args) : value
  }
  const shared = {
    plan: step('plan', over.plan ?? plan()),
    shown: over.shown ?? (() => true),
    confirm: async (question) => {
      calls.push('confirm')
      questions.push(question)
      return over.confirm ?? true
    }
  }
  return {
    calls,
    questions,
    promote: () =>
      promoteWorktree({
        ...shared,
        teardownPlan: step('teardownPlan', 'teardownPlan' in over ? over.teardownPlan : []),
        blocker: step('blocker', over.blocker ?? null),
        promote: step('promote', over.promote ?? result())
      }),
    demote: () => demoteBranch({ ...shared, demote: step('demote', over.demote ?? result({ worktreeId: 'new-id' })) })
  }
}

test('promote: the plan, the teardown plan, the question, then the promote', async () => {
  const f = flow()
  assert.deepEqual(await f.promote(), { kind: 'done', worktreeId: 'main-id', notes: null })
  assert.deepEqual(f.calls, ['plan', 'teardownPlan', 'confirm', 'promote()'])
  assert.equal(f.questions[0].message, 'Promote “feat” to the primary checkout?')
  assert.equal(f.questions[0].confirmLabel, 'Promote')
  assert.match(f.questions[0].detail, /will be checked out in the main checkout at \/r/)
})

test("promote: the plan's default teardown items are named in the question and sent", async () => {
  const items = [
    { id: 'stack:destroy', label: 'Tear down the dev stack', checked: true },
    { id: 'vm:delete', label: 'Delete the VM', checked: false, running: true }
  ]
  const f = flow({ teardownPlan: items })
  assert.equal((await f.promote()).kind, 'done')
  assert.deepEqual(f.calls, ['plan', 'teardownPlan', 'confirm', 'promote(stack:destroy)'])
  assert.match(f.questions[0].detail, / Also: Tear down the dev stack\. Not done \(still running\): Delete the VM\.$/)
})

test('promote: a refused dry run asks nothing and says why', async () => {
  const f = flow({ plan: rejects(coded('IN_USE', '/r has running sessions in B; unload it there first')) })
  const outcome = await f.promote()
  assert.equal(outcome.kind, 'failed')
  assert.match(outcome.text, /^Another project on the server has this checkout loaded\./)
  assert.deepEqual(f.calls, ['plan'])

  const noPlan = flow({ teardownPlan: rejects(new Error('offline')) })
  assert.deepEqual(await noPlan.promote(), { kind: 'failed', text: 'offline' })
  assert.deepEqual(noPlan.calls, ['plan', 'teardownPlan'])
})

test('promote: an older server (no teardown plan) is blocked by a running stack, before or after the question', async () => {
  const before = flow({ teardownPlan: null, blocker: 'its dev stack is running' })
  assert.deepEqual(await before.promote(), { kind: 'blocked', why: 'its dev stack is running' })
  assert.deepEqual(before.calls, ['plan', 'teardownPlan', 'blocker'])

  let asked = 0
  const after = flow({ teardownPlan: null, blocker: () => (asked++ === 0 ? null : 'its Docker VM (trek-feat) is running') })
  assert.deepEqual(await after.promote(), { kind: 'blocked', why: 'its Docker VM (trek-feat) is running' })
  assert.deepEqual(after.calls, ['plan', 'teardownPlan', 'blocker', 'confirm', 'blocker'])

  const clear = flow({ teardownPlan: null })
  assert.equal((await clear.promote()).kind, 'done')
  assert.deepEqual(clear.calls, ['plan', 'teardownPlan', 'blocker', 'confirm', 'blocker', 'promote()'])
})

test('promote: declined, or the screen left before the question, does nothing', async () => {
  const declined = flow({ confirm: false })
  assert.deepEqual(await declined.promote(), { kind: 'cancelled' })
  assert.deepEqual(declined.calls, ['plan', 'teardownPlan', 'confirm'])

  const left = flow({ shown: () => false })
  assert.deepEqual(await left.promote(), { kind: 'cancelled' })
  assert.deepEqual(left.calls, ['plan', 'teardownPlan'])
})

test('promote: a failed teardown, and a failure after it, are said as the desktop says them', async () => {
  const teardown = flow({ promote: rejects(coded('TOOL_ERROR', 'stack destroy failed', { reason: 'teardown' })) })
  assert.deepEqual(await teardown.promote(), {
    kind: 'failed',
    text: "The teardown before the promote failed: stack destroy failed. Nothing was promoted. To promote it without that step, untick it in the desktop's confirm."
  })

  const later = flow({ promote: rejects(coded('GIT_ERROR', 'checkout failed', { tornDown: ['Tear down the dev stack'] })) })
  assert.deepEqual(await later.promote(), { kind: 'failed', text: 'checkout failed The teardown had already run and is not undone: Tear down the dev stack.' })

  const locked = flow({ promote: rejects(coded('CONFLICT', '/r-feat is locked (git worktree lock); unlock it first')) })
  assert.match((await locked.promote()).text, /^The worktree is locked/)
})

test("promote: a result's notes and recovery file come back as one text", async () => {
  const f = flow({ promote: result({ notes: ['“Codex 1” was closed.'], recoveryFile: '/d/x.patch' }) })
  assert.deepEqual(await f.promote(), { kind: 'done', worktreeId: 'main-id', notes: '“Codex 1” was closed.\nA copy of the carried work is kept at /d/x.patch.' })
})

test('demote: the plan, the question, then the demote', async () => {
  const f = flow()
  assert.deepEqual(await f.demote(), { kind: 'done', worktreeId: 'new-id', notes: null })
  assert.deepEqual(f.calls, ['plan', 'confirm', 'demote'])
  assert.equal(f.questions[0].title, 'Promote Branch to Worktree')
  assert.equal(f.questions[0].confirmLabel, 'Move to Worktree')

  const declined = flow({ confirm: false })
  assert.deepEqual(await declined.demote(), { kind: 'cancelled' })
  assert.deepEqual(declined.calls, ['plan', 'confirm'])

  const left = flow({ shown: () => false })
  assert.deepEqual(await left.demote(), { kind: 'cancelled' })
  assert.deepEqual(left.calls, ['plan'])

  const refused = flow({ plan: rejects(coded('BAD_REQUEST', 'detached HEAD')) })
  assert.deepEqual(await refused.demote(), { kind: 'failed', text: 'detached HEAD' })

  const failed = flow({ demote: rejects(coded('IN_USE', '/r has running sessions in B')) })
  assert.match((await failed.demote()).text, /^Another project on the server has this checkout loaded\./)
})

test('errorCode: a coded error, else null', () => {
  assert.equal(errorCode(coded('IN_USE', 'x')), 'IN_USE')
  assert.equal(errorCode(new Error('x')), null)
  assert.equal(errorCode('x'), null)
})
