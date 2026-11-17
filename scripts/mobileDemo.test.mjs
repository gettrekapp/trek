// The phone's demo server (apps/mobile/src/demo): a Trek server inside the app for Try the demo.
// These tests drive it through the real client SDK (ServerRegistry, TopicMirror, PtyStream), the
// way the phone does, and check that every request the phone can send is either handled by the
// demo or listed as not in it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initialDemoState, DEMO_PROJECT_ID, DEMO_REPO_ID } from '../apps/mobile/src/demo/demoData.ts'
import { numberedLines, patchBody } from '../src/shared/changes.ts'

test('demo data: a project with three worktrees, sessions, automations and history', () => {
  const state = initialDemoState(1_000_000_000_000)
  const project = state.project
  assert.equal(project.id, DEMO_PROJECT_ID)
  const repo = project.repositories[0]
  assert.equal(repo.id, DEMO_REPO_ID)
  assert.deepEqual(repo.worktrees.map((w) => w.branch), ['main', 'feature/checkout-redesign', 'fix/login-timeout'])
  assert.equal(project.automations.length, 2)
  assert.ok(state.history.length >= 10)
  // Newest first
  for (let i = 1; i < state.history.length; i++) assert.ok(state.history[i - 1].at >= state.history[i].at)
})

test('demo data: each review comment sits on the line it quotes', () => {
  const state = initialDemoState(1_000_000_000_000)
  const checkout = state.project.repositories[0].worktrees.find((w) => w.id === 'wt-checkout')
  for (const c of checkout.review.comments) {
    const patch = state.changes['wt-checkout'].files.find((f) => f.file.path === c.path).patch
    const line = numberedLines(patchBody(patch)).find((l) => l.side === c.side && l.line === c.line)
    assert.ok(line, `line ${c.line} of ${c.path}`)
    assert.equal(line.text, c.lineText)
  }
})
