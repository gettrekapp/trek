// scripts/serverPromoteTool.test.mjs — the trek-dev tool promote_to_primary (phase 5e): it asks the
// project's windows (promote.request), waits for one's promote.answer, and says what came of it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createToolCaller } from '../server/src/mcp/tools.ts'
import { CLAUDE_ID, setup } from './promoteFixture.mjs'

test('promote_to_primary: refused with no window; a window declines, or confirms and answers', async (t) => {
  const s = await setup(t)
  const tools = createToolCaller({ store: s.ctx.store, hub: s.hub, projects: s.projects, poller: s.poller, sessions: s.sessions, promoteRequests: s.promoteRequests })(s.projectId)
  await assert.rejects(tools('promote_to_primary', { worktree: 'feat' }), /No Trek window/)
  await assert.rejects(tools('promote_to_primary', { worktree: s.app }), /already the primary/)
  const events = []
  let reply = 'declined'
  const window = {
    send() {},
    event(event, payload) {
      events.push([event, payload])
      if (event !== 'promote.request') return true
      setImmediate(async () => {
        if (reply === 'declined') {
          await s.call('promote.answer', { projectId: s.projectId, requestId: payload.requestId, outcome: 'declined' })
          return
        }
        // As a window does: it runs the promote itself, then answers.
        const done = await s.call('worktree.promote', { projectId: s.projectId, worktreeId: payload.worktreeId })
        await s.call('promote.answer', { projectId: s.projectId, requestId: payload.requestId, outcome: 'promoted', worktreeId: done.result.worktreeId })
      })
      return true
    }
  }
  s.hub.subscribe(`project:${s.projectId}`, window)
  await assert.rejects(tools('promote_to_primary', { worktree: 'feat', terminalId: CLAUDE_ID }), /declined/)
  const asked = events.find(([e]) => e === 'promote.request')[1]
  assert.equal(asked.branch, 'feat')
  assert.equal(asked.from, 'Claude 1')
  assert.ok(events.some(([e, p]) => e === 'promote.settled' && p.requestId === asked.requestId))
  assert.ok(existsSync(s.path))
  reply = 'promoted'
  const result = await tools('promote_to_primary', { worktree: 'feat' })
  assert.equal(result.promoted, true)
  assert.equal(result.primary.primary, true)
  assert.equal(result.primary.branch, 'feat')
  assert.ok(!existsSync(s.path))
})

test('promote_to_primary ends when the last window goes away', async (t) => {
  const s = await setup(t)
  const tools = createToolCaller({ store: s.ctx.store, hub: s.hub, projects: s.projects, poller: s.poller, sessions: s.sessions, promoteRequests: s.promoteRequests })(s.projectId)
  const window = { send() {}, event: () => true }
  s.hub.subscribe(`project:${s.projectId}`, window)
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const pending = tools('promote_to_primary', { worktree: 'feat' })
  setTimeout(() => s.hub.unsubscribe(`project:${s.projectId}`, window), 50)
  await assert.rejects(pending, /No Trek window/)
})
