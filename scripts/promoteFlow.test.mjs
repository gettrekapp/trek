// scripts/promoteFlow.test.mjs — the promote confirmations' text (phase 5e) and the window's
// follower of promote_to_primary's requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { demotePrompt, followPromoteRequests, promotePrompt } from '../src/renderer/src/v2/promoteFlow.ts'

const plan = (extra = {}) => ({
  branch: 'feat', mainPath: '/r', worktreePath: '/r-feat', mainBranch: 'main', dirty: false, loaded: false, otherLoaded: false,
  sessions: [], reviewComments: 0, reviewCarried: false, ignored: [], ignoredCount: 0, hiddenChanges: [], hiddenChangesCount: 0, ...extra
})

test('promotePrompt says what moves, what is closed, what is lost and who asked', () => {
  const p = promotePrompt(
    plan({
      dirty: true, loaded: true, otherLoaded: true,
      sessions: [{ title: 'Claude 1', provider: 'claude', carried: true }, { title: 'Codex 1', provider: 'codex', carried: false, reason: 'x' }],
      reviewComments: 2, reviewCarried: false, ignored: ['a/', 'b', 'c', 'd', 'e', 'f'], ignoredCount: 7, hiddenChanges: ['h'], hiddenChangesCount: 1
    }),
    { vm: 'trek-feat', asked: { from: 'Claude 1', stillAsked: () => true } }
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
  assert.doesNotMatch(promotePrompt(plan()).detail, /asked|resume|review|ignored/)
})

test('demotePrompt says where the branch goes and which sessions stay', () => {
  const p = demotePrompt(plan({ dirty: true, sessions: [{ title: 'A', provider: 'claude', carried: true }, { title: 'G', provider: 'gemini', carried: false }], reviewComments: 1, reviewCarried: true }))
  assert.equal(p.confirmLabel, 'Move to Worktree')
  assert.match(p.detail, /created at \/r-feat, and the main checkout goes back to “main”/)
  assert.match(p.detail, /“G” can't follow and stays in the main checkout/)
  assert.match(p.detail, /review draft \(1 comment\) moves too/)
})

test('followPromoteRequests: one at a time, in order; settled ones skipped or left unanswered; a throw is a failure', async () => {
  const on = { request: [], settled: [] }
  const answers = []
  const ran = []
  let release
  const gate = new Promise((r) => { release = r })
  let left = false
  const off = followPromoteRequests({
    onRequest: (l) => { on.request.push(l); return () => { on.request = [] } },
    onSettled: (l) => { on.settled.push(l); return () => { on.settled = [] } },
    run: async (event, asked) => {
      ran.push(event.requestId)
      if (event.requestId === 'a') await gate
      if (event.requestId === 'boom') throw new Error('kaput')
      return asked.stillAsked() ? { outcome: 'promoted', worktreeId: 'm' } : { outcome: 'declined' }
    },
    answer: async (requestId, outcome) => void answers.push([requestId, outcome]),
    left: () => left
  })
  const ask = (requestId) => on.request[0]({ projectId: 'p', requestId, worktreeId: 'w', branch: 'b' })
  ask('a')
  ask('b')
  ask('boom')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(ran, ['a'])
  // b is answered elsewhere before its turn; a while its dialog is open.
  on.settled[0]({ projectId: 'p', requestId: 'b' })
  on.settled[0]({ projectId: 'p', requestId: 'a' })
  release()
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
  assert.deepEqual(ran, ['a', 'boom'])
  assert.deepEqual(answers, [['boom', { outcome: 'failed', error: 'kaput' }]])
  left = true
  ask('c')
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  assert.deepEqual(ran, ['a', 'boom'])
  off()
  assert.equal(on.request.length, 0)
})
