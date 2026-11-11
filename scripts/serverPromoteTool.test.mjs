// scripts/serverPromoteTool.test.mjs — the trek-dev tool promote_to_primary (phase 5e): it asks the
// windows that listen (promote.listen) with promote.request; the first to confirm claims it
// (promote.claim) and runs worktree.promote with the requestId, whose own result settles it; a
// decline is promote.answer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createToolCaller } from '../server/src/mcp/tools.ts'
import { CLAUDE_ID, setup } from './promoteFixture.mjs'

const toolsOf = (s) => createToolCaller({ store: s.ctx.store, hub: s.hub, projects: s.projects, poller: s.poller, sessions: s.sessions, promoteRequests: s.promoteRequests })(s.projectId)

/** A window connection: subscribed to the project's topic, listening for requests unless told not to. */
async function windowOf(s, onRequest, { listen = true } = {}) {
  const events = []
  const window = {
    send() {},
    event(event, payload) {
      events.push([event, payload])
      if (event === 'promote.request') setImmediate(() => onRequest(payload, window))
      return true
    }
  }
  s.hub.subscribe(`project:${s.projectId}`, window)
  if (listen) assert.equal((await s.callAs(window, 'promote.listen', { projectId: s.projectId })).ok, true)
  return { window, events, call: (method, params) => s.callAs(window, method, params) }
}

/** As a window that confirms: claims first, then runs the promote with the requestId. */
const confirm = (s) => async (payload, window) => {
  const claimed = await s.callAs(window, 'promote.claim', { projectId: s.projectId, requestId: payload.requestId })
  assert.deepEqual(claimed, { ok: true, result: { accepted: true } })
  await s.callAs(window, 'worktree.promote', { projectId: s.projectId, worktreeId: payload.worktreeId, requestId: payload.requestId })
}

test('promote_to_primary: refused with no window; a window declines, or confirms and the promote settles it', async (t) => {
  const s = await setup(t)
  const tools = toolsOf(s)
  await assert.rejects(tools('promote_to_primary', { worktree: 'feat' }), /No Trek window/)
  await assert.rejects(tools('promote_to_primary', { worktree: s.app }), /already the primary/)
  let reply = 'declined'
  const w = await windowOf(s, async (payload, window) => {
    if (reply === 'declined') {
      await s.callAs(window, 'promote.answer', { projectId: s.projectId, requestId: payload.requestId, outcome: 'declined' })
      return
    }
    await confirm(s)(payload, window)
  })
  await assert.rejects(tools('promote_to_primary', { worktree: 'feat', terminalId: CLAUDE_ID }), /declined/)
  const asked = w.events.find(([e]) => e === 'promote.request')[1]
  assert.equal(asked.branch, 'feat')
  assert.equal(asked.from, 'Claude 1')
  assert.ok(w.events.some(([e, p]) => e === 'promote.settled' && p.requestId === asked.requestId))
  assert.ok(existsSync(s.path))
  reply = 'promoted'
  const result = await tools('promote_to_primary', { worktree: 'feat' })
  assert.equal(result.promoted, true)
  assert.equal(result.primary.primary, true)
  assert.equal(result.primary.branch, 'feat')
  assert.ok(!existsSync(s.path))
})

test('promote_to_primary: a subscriber that does not listen is no window', async (t) => {
  const s = await setup(t)
  await windowOf(s, () => assert.fail('asked'), { listen: false })
  await assert.rejects(toolsOf(s)('promote_to_primary', { worktree: 'feat' }), /No Trek window/)
})

test('promote_to_primary ends when the last window goes away', async (t) => {
  const s = await setup(t)
  const w = await windowOf(s, () => {})
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const pending = toolsOf(s)('promote_to_primary', { worktree: 'feat' })
  setTimeout(() => s.hub.unsubscribe(`project:${s.projectId}`, w.window), 50)
  await assert.rejects(pending, /No Trek window/)
})

test('promote_to_primary: the first claim wins; the other windows are told, and their answers do nothing', async (t) => {
  const s = await setup(t)
  const answers = []
  let release
  const gate = new Promise((r) => { release = r })
  const a = await windowOf(s, async (payload, window) => {
    assert.deepEqual(await s.callAs(window, 'promote.claim', { projectId: s.projectId, requestId: payload.requestId }), { ok: true, result: { accepted: true } })
    // Its teardown takes a while; the other window answers meanwhile.
    await gate
    await s.callAs(window, 'worktree.promote', { projectId: s.projectId, worktreeId: payload.worktreeId, requestId: payload.requestId })
  })
  const b = await windowOf(s, async (payload, window) => {
    await new Promise((r) => setTimeout(r, 30))
    answers.push(await s.callAs(window, 'promote.answer', { projectId: s.projectId, requestId: payload.requestId, outcome: 'declined' }))
    answers.push(await s.callAs(window, 'promote.claim', { projectId: s.projectId, requestId: payload.requestId }))
    // Nor can it run the promote for that request.
    answers.push(await s.callAs(window, 'worktree.promote', { projectId: s.projectId, worktreeId: payload.worktreeId, requestId: payload.requestId }))
    release()
  })
  const result = await toolsOf(s)('promote_to_primary', { worktree: 'feat' })
  assert.equal(result.promoted, true)
  assert.deepEqual(answers[0], { ok: true, result: { accepted: false } })
  assert.deepEqual(answers[1], { ok: true, result: { accepted: false } })
  assert.equal(answers[2].ok, false)
  assert.equal(answers[2].error.code, 'CONFLICT')
  const id = a.events.find(([e]) => e === 'promote.request')[1].requestId
  assert.ok(b.events.some(([e, p]) => e === 'promote.settled' && p.requestId === id && p.claimed === true))
  assert.ok(!existsSync(s.path))
})

test('promote_to_primary: a failed promote settles the request with its error', async (t) => {
  const s = await setup(t)
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  writeFileSync(join(s.app, 'README'), 'dirty main\n')
  await windowOf(s, confirm(s))
  await assert.rejects(toolsOf(s)('promote_to_primary', { worktree: 'feat' }), /The promote failed: .*uncommitted changes/)
  assert.ok(existsSync(s.path))
})

test('promote_to_primary: a second call for the same worktree joins the first and gets its outcome', async (t) => {
  const s = await setup(t)
  const w = await windowOf(s, async (payload, window) => {
    await new Promise((r) => setTimeout(r, 50))
    await confirm(s)(payload, window)
  })
  const tools = toolsOf(s)
  const [one, two] = await Promise.all([tools('promote_to_primary', { worktree: 'feat' }), tools('promote_to_primary', { worktree: 'feat' })])
  assert.equal(w.events.filter(([e]) => e === 'promote.request').length, 1)
  assert.equal(one.promoted, true)
  assert.equal(two.promoted, true)
  assert.equal(one.primary.id ?? one.primary.path, two.primary.id ?? two.primary.path)
})

test('promote_to_primary: the caller going away before a claim cancels; after one, the promote settles and the caller hears it in its queue', async (t) => {
  const s = await setup(t)
  const tools = toolsOf(s)
  // Before a claim: cancelled, and the windows are told.
  const quiet = await windowOf(s, () => {})
  const early = new AbortController()
  const first = tools('promote_to_primary', { worktree: 'feat', terminalId: CLAUDE_ID }, early.signal)
  setTimeout(() => early.abort(), 30)
  await assert.rejects(first, /disconnect/i)
  assert.ok(quiet.events.some(([e, p]) => e === 'promote.settled' && !p.claimed))
  s.hub.unsubscribe(`project:${s.projectId}`, quiet.window)
  // After a claim: the asking agent (in the worktree) is stopped by the promote and its call drops.
  const late = new AbortController()
  await windowOf(s, async (payload, window) => {
    await s.callAs(window, 'promote.claim', { projectId: s.projectId, requestId: payload.requestId })
    late.abort()
    await s.callAs(window, 'worktree.promote', { projectId: s.projectId, worktreeId: payload.worktreeId, requestId: payload.requestId })
  })
  const result = await tools('promote_to_primary', { worktree: 'feat', terminalId: CLAUDE_ID }, late.signal)
  assert.equal(result.promoted, true)
  assert.ok(!existsSync(s.path))
  const moved = s.repo().worktrees.find((w) => w.isMain).sessions.find((x) => x.id === CLAUDE_ID)
  assert.deepEqual(moved.queue.slice(0, 1), ['later'])
  assert.match(moved.queue[1], /went through: feat is now checked out in the main checkout at /)
})

test('promote_to_primary: a claim whose window goes away, or never starts the promote, fails', async (t) => {
  const s = await setup(t, { requests: { claimMs: 100 } })
  // The broker's timers never hold the process open.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const tools = toolsOf(s)
  const w = await windowOf(s, async (payload, window) => {
    await s.callAs(window, 'promote.claim', { projectId: s.projectId, requestId: payload.requestId })
  })
  await assert.rejects(tools('promote_to_primary', { worktree: 'feat' }), /did not start it in time/)
  // The claimant's connection closes before its promote.
  w.window.event = (event, payload) => {
    if (event === 'promote.request') {
      setImmediate(async () => {
        await s.callAs(w.window, 'promote.claim', { projectId: s.projectId, requestId: payload.requestId })
        s.promoteRequests.forget(w.window)
      })
    }
    return true
  }
  await assert.rejects(tools('promote_to_primary', { worktree: 'feat' }), /went away before it started/)
  assert.ok(existsSync(s.path))
})

test('worktree.promote with a requestId refuses another worktree\'s request', async (t) => {
  const s = await setup(t)
  let seen
  const w = await windowOf(s, async (payload, window) => {
    seen = await s.callAs(window, 'worktree.promote', { projectId: s.projectId, worktreeId: s.mainId, requestId: payload.requestId })
    await s.callAs(window, 'promote.answer', { projectId: s.projectId, requestId: payload.requestId, outcome: 'declined' })
  })
  await assert.rejects(toolsOf(s)('promote_to_primary', { worktree: 'feat' }), /declined/)
  assert.equal(seen.ok, false)
  assert.equal(seen.error.code, 'BAD_REQUEST')
  assert.ok(w.events.length > 0)
})
