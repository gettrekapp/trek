// scripts/promoteFlow.test.mjs — the promote confirmations' text (phase 5e) and the window's
// follower of promote_to_primary's requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { REQUEST_ENDED, demotePrompt, followPromoteRequests, isPromoting, markPromoting, promoteErrorText, promotePrompt, resultNotes } from '../src/renderer/src/v2/promoteFlow.ts'

const plan = (extra = {}) => ({
  branch: 'feat', mainPath: '/r', worktreePath: '/r-feat', mainBranch: 'main', dirty: false, loaded: false, otherLoaded: false,
  sessions: [], reviewComments: 0, reviewCarried: false, ignored: [], ignoredCount: 0, hiddenChanges: [], hiddenChangesCount: 0, mainIgnored: [], mainIgnoredCount: 0, overwrittenIgnored: [], overwrittenIgnoredCount: 0, ...extra
})

test('promotePrompt says what moves, what is closed, what is lost and who asked', () => {
  const p = promotePrompt(
    plan({
      dirty: true, loaded: true, otherLoaded: true,
      sessions: [{ title: 'Claude 1', provider: 'claude', carried: true }, { title: 'Codex 1', provider: 'codex', carried: false, reason: 'x' }],
      reviewComments: 2, reviewCarried: false, ignored: ['a/', 'b', 'c', 'd', 'e', 'f'], ignoredCount: 7, hiddenChanges: ['h'], hiddenChangesCount: 1
    }),
    { vm: 'trek-feat', asked: { from: 'Claude 1', dialogId: 'promote:r1' } }
  )
  assert.equal(p.title, 'Promote to Primary')
  assert.equal(p.confirmLabel, 'Promote')
  assert.match(p.detail, /^“Claude 1” asked for this \(promote_to_primary\)\./)
  assert.match(p.detail, /uncommitted changes move with it/)
  assert.match(p.detail, /1 session \(Claude 1\) move to the main checkout and resume/)
  assert.match(p.detail, /“Codex 1” can't follow and is closed/)
  assert.match(p.detail, /main checkout's own sessions keep running/)
  assert.match(p.detail, /review draft \(2 comments\) is dropped/)
  assert.match(p.detail, /a\/, b, c, d, e and 2 more/)
  assert.match(p.detail, /skip-worktree or assume-unchanged\): h\./)
  assert.match(p.detail, /Colima VM “trek-feat”/)
  assert.equal(p.dialogId, 'promote:r1')
  assert.doesNotMatch(promotePrompt(plan()).detail, /asked|resume|review|ignored/)
  assert.equal(promotePrompt(plan()).dialogId, undefined)
})

test('demotePrompt says where the branch goes and which sessions stay', () => {
  const p = demotePrompt(plan({ dirty: true, sessions: [{ title: 'A', provider: 'claude', carried: true }, { title: 'G', provider: 'gemini', carried: false }], reviewComments: 1, reviewCarried: true }))
  assert.equal(p.confirmLabel, 'Move to Worktree')
  assert.match(p.detail, /created at \/r-feat, and the main checkout goes back to “main”/)
  assert.match(p.detail, /“G” can't follow and stays in the main checkout/)
  assert.match(p.detail, /review draft \(1 comment\) moves too/)
})

test("the main checkout's ignored files: those overwritten are a warning, those kept are said, with counts and a short list", () => {
  const p = promotePrompt(plan({ mainIgnored: ['node_modules/', '.env'], mainIgnoredCount: 2, overwrittenIgnored: ['gen.ts'], overwrittenIgnoredCount: 1 }))
  assert.match(p.detail, /Warning: 1 ignored file in the main checkout is tracked by “feat” and will be overwritten: gen\.ts\./)
  assert.match(p.detail, /The main checkout's 2 ignored files stay as they are: node_modules\/, \.env\./)
  const d = demotePrompt(plan({ mainIgnored: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], mainIgnoredCount: 9, overwrittenIgnored: ['x', 'y'], overwrittenIgnoredCount: 2 }))
  assert.match(d.detail, /Warning: 2 ignored files in the main checkout are tracked by “main” and will be overwritten: x, y\./)
  assert.match(d.detail, /9 ignored files stay there; the new worktree won't have them: a, b, c, d, e and 4 more\./)
})

test('promoteErrorText: IN_USE, a locked worktree, a checkout not put back (the recovery file named), else the text', () => {
  const coded = (code, message) => Object.assign(new Error(message), { code })
  assert.match(promoteErrorText(coded('IN_USE', '/r has running sessions in B; unload it there first')), /^Another project on the server has this checkout loaded\. .*\n\n\/r has running sessions in B/)
  assert.match(promoteErrorText(coded('CONFLICT', '/r-feat is locked (git worktree lock); unlock it first')), /^The worktree is locked/)
  const kept = promoteErrorText(coded('CONFLICT', 'the main checkout /r changed while the demote ran, so it was not put back: it is left as it is. A copy of the uncommitted work is saved at /d/x.patch'))
  assert.match(kept, /^The checkout was left as it is, not put back/)
  assert.match(kept, /\n\nRecovery file \(the uncommitted work\): \/d\/x\.patch$/)
  assert.equal(promoteErrorText(coded('BAD_REQUEST', 'detached HEAD')), 'detached HEAD')
  assert.equal(resultNotes({ notes: [] }), null)
  assert.equal(resultNotes({ notes: ['n /d/y.patch'], recoveryFile: '/d/y.patch' }), 'n /d/y.patch')
})

test('markPromoting: a worktree is busy until each mark is released', () => {
  const a = markPromoting('/w')
  const b = markPromoting('/w')
  a()
  a()
  assert.equal(isPromoting('/w'), true)
  b()
  assert.equal(isPromoting('/w'), false)
})

/** A follower over fakes: `ask` sends a request, `settle` a settled event; `run` is the test's. */
function follow({ run, claim = async () => true, answer = async () => true, claimRefreshMs } = {}) {
  const on = { request: [], settled: [], connected: [] }
  const out = { answers: [], closed: [], errors: [], logs: [], claims: [] }
  let left = false
  const follower = followPromoteRequests({
    onRequest: (l) => { on.request.push(l); return () => { on.request = [] } },
    onSettled: (l) => { on.settled.push(l); return () => { on.settled = [] } },
    onConnected: (l) => { on.connected.push(l); return () => { on.connected = on.connected.filter((x) => x !== l) } },
    ...(claimRefreshMs ? { claimRefreshMs } : {}),
    run,
    // A boolean from the test's claim is its `accepted`, with a token when accepted.
    claim: async (id, token) => {
      out.claims.push(token ? [id, token] : id)
      const r = await claim(id, on, token)
      return typeof r === 'boolean' ? { accepted: r, ...(r ? { claimToken: `tok-${id}` } : {}) } : r
    },
    answer: async (id, outcome, token) => { out.answers.push(token ? [id, outcome, token] : [id, outcome]); return answer(id, outcome) },
    closeDialog: (id) => void out.closed.push(id),
    showError: async (title, message) => void out.errors.push(message),
    log: (message) => void out.logs.push(message),
    left: () => left
  })
  const ask = (requestId) => on.request[0]?.({ projectId: 'p', requestId, worktreeId: 'w', branch: 'b' })
  const settle = (requestId, claimed) => on.settled[0]?.({ projectId: 'p', requestId, ...(claimed ? { claimed: true } : {}) })
  return { follower, ask, settle, out, on, leave: () => { left = true } }
}
const drain = async (n = 15) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

test('followPromoteRequests: one at a time, in order; settled before its turn skipped; settled while open closes the dialog and answers nothing', async () => {
  const ran = []
  let release
  const gate = new Promise((r) => { release = r })
  const f = follow({
    run: async (event, asked) => {
      ran.push(event.requestId)
      if (event.requestId === 'a') {
        await gate
        if (!asked.stillAsked()) return
      }
      await asked.answer({ outcome: 'declined' })
    }
  })
  f.ask('a')
  f.ask('b')
  f.ask('a') // never asked twice
  f.ask('c')
  await drain()
  assert.deepEqual(ran, ['a'])
  f.settle('b')
  f.settle('a', true) // another window claimed it while its dialog was open
  assert.deepEqual(f.out.closed, ['promote:b', 'promote:a'])
  release()
  await drain()
  assert.deepEqual(ran, ['a', 'c'])
  assert.deepEqual(f.out.answers, [['c', { outcome: 'declined' }]])
})

test("followPromoteRequests: this window's claim ignores its own claimed and settled events; a throw after it answers failed", async () => {
  let stillAfter
  const f = follow({
    claim: async (id, on) => {
      on.settled[0]({ projectId: 'p', requestId: id, claimed: true })
      return true
    },
    run: async (event, asked) => {
      assert.equal(await asked.claim(), true)
      f.settle(event.requestId)
      stillAfter = asked.stillAsked()
      throw new Error('kaput')
    }
  })
  f.ask('a')
  await drain()
  assert.equal(stillAfter, true)
  assert.deepEqual(f.out.closed, [])
  assert.deepEqual(f.out.answers, [['a', { outcome: 'failed', error: 'kaput' }, 'tok-a']])
  assert.match(f.out.logs[0], /threw/)
})

test('followPromoteRequests: a lost claim says the request ended (silent when asked to); a rejected one is logged and shown', async () => {
  const results = []
  const f = follow({
    claim: async (id) => {
      if (id === 'boom') throw new Error('socket closed')
      return false
    },
    run: async (event, asked) => void results.push(await asked.claim({ silent: event.requestId === 'quiet' }))
  })
  f.ask('lost')
  f.ask('quiet')
  f.ask('boom')
  await drain()
  assert.deepEqual(results, [false, false, false])
  assert.equal(f.out.errors[0], REQUEST_ENDED)
  assert.equal(f.out.errors.length, 2)
  assert.match(f.out.errors[1], /socket closed/)
  assert.match(f.out.logs[0], /promote\.claim for boom failed/)
})

test('followPromoteRequests: stop closes what was asked and follows nothing more', async () => {
  const ran = []
  const f = follow({ run: async (event) => void ran.push(event.requestId) })
  f.ask('a')
  await drain()
  f.follower.stop()
  assert.deepEqual(f.out.closed, ['promote:a'])
  f.ask('b')
  await drain()
  assert.deepEqual(ran, ['a'])
  assert.equal(f.on.request.length, 0)
})

test('followPromoteRequests: a held claim is refreshed with its token on a timer and on every reconnect, until released (I1)', async () => {
  let release
  let token
  const f = follow({
    claimRefreshMs: 20,
    run: async (event, asked) => {
      assert.equal(await asked.claim(), true)
      token = asked.claimToken()
      const stop = asked.holdClaim()
      await new Promise((r) => { release = r })
      stop()
      stop()
    }
  })
  f.ask('a')
  await drain()
  assert.equal(token, 'tok-a')
  await new Promise((r) => setTimeout(r, 70))
  for (const l of f.on.connected) l()
  await drain()
  const refreshes = f.out.claims.filter((c) => Array.isArray(c))
  assert.ok(refreshes.length >= 3, JSON.stringify(f.out.claims))
  assert.ok(refreshes.every(([id, t]) => id === 'a' && t === 'tok-a'))
  release()
  await drain()
  const count = f.out.claims.length
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(f.on.connected.length, 0)
  assert.equal(f.out.claims.length, count)
})

test('followPromoteRequests: a refresh the server no longer accepts is logged; holding without a claim does nothing', async () => {
  let calls = 0
  let stopA
  const f = follow({
    claimRefreshMs: 15,
    claim: async (id, _on, token) => (token ? { accepted: false } : (calls += 1, true)),
    run: async (event, asked) => {
      if (event.requestId === 'b') {
        const stop = asked.holdClaim()
        stop()
        return
      }
      await asked.claim()
      stopA = asked.holdClaim()
      await new Promise((r) => setTimeout(r, 40))
      stopA()
    }
  })
  f.ask('a')
  f.ask('b')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(calls, 1)
  assert.match(f.out.logs[0], /promote\.claim \(refresh\) for a was not accepted/)
  assert.ok(!f.out.claims.includes('b'))
})
