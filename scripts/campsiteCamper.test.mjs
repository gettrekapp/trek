// scripts/campsiteCamper.test.mjs — a camper's hover label and card (the strip's and the collapsed
// bar's hikers): its crew member, or a day hiker, and this trip.
import test from 'node:test'
import assert from 'node:assert/strict'
import { camperCard, camperLabel, xpProgress } from '../plugins/campsite/shared/campView.ts'

const member = (over = {}) => ({ id: 'c1', name: 'Aspen', seed: 1, level: 2, title: 'Trailblazer', xp: 150, next: 300, gear: {}, bonus: 0, pin: null, journalCount: 0, journalAt: 0, ...over })
const snap = (crew = [member()], assignments = { t1: 'c1' }) => ({ crew, assignments })
const session = (over = {}) => ({ terminalId: 't1', label: 'Claude 2', worktreeId: 'w1', worktreeName: 'api', branch: 'feature/api', ...over })

test('camperLabel: the member and the tab; a day hiker; the tab alone before the camp loads', () => {
  assert.equal(camperLabel(snap(), session()), 'Aspen · Claude 2')
  assert.equal(camperLabel(snap([member()], {}), session()), 'Day hiker · Claude 2')
  assert.equal(camperLabel(null, session()), 'Claude 2')
  // An assignment whose member is no longer in the crew: a day hiker
  assert.equal(camperLabel(snap([], { t1: 'c1' }), session()), 'Day hiker · Claude 2')
  // Only the snapshot's own keys answer
  assert.equal(camperLabel(snap([member()], {}), session({ terminalId: 'toString' })), 'Day hiker · Claude 2')
})

test('camperCard: a member with no bonus and no pin', () => {
  const m = member()
  assert.deepEqual(camperCard(snap([m]), session(), 'Agent is working'), {
    member: { id: 'c1', name: 'Aspen', level: 'Lv 2 Trailblazer', xp: '150 / 300 XP', progress: Math.round(xpProgress(m) * 100), bonus: null, pin: null },
    tab: 'Claude 2',
    place: 'api',
    doing: 'Agent is working'
  })
})

test('camperCard: the gear bonus and the pin, a session type or an agent', () => {
  const typed = camperCard(snap([member({ bonus: 10, pin: { kind: 'type', id: 'p:review', name: 'Review' } })]), session(), 'Waiting')
  assert.equal(typed.member.bonus, '+10% wood')
  assert.equal(typed.member.pin, 'Goes out on Session type: Review')
  const agent = camperCard(snap([member({ pin: { kind: 'provider', id: 'codex', name: 'Codex' } })]), session(), 'Waiting')
  assert.equal(agent.member.pin, 'Goes out on Agent: Codex')
})

test('camperCard: a day hiker; Global; the branch when the worktree has no name; nothing to name', () => {
  assert.equal(camperCard(snap([member()], {}), session(), 'Idle').member, null)
  assert.equal(camperCard(snap(), session({ worktreeId: null, worktreeName: null, branch: null }), 'Idle').place, 'Global')
  assert.equal(camperCard(snap(), session({ worktreeName: null }), 'Idle').place, 'feature/api')
  assert.equal(camperCard(snap(), session({ worktreeName: null, branch: null }), 'Idle').place, '')
})
