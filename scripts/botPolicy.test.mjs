// scripts/botPolicy.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { decide, approvalMatches } from '../src/host/bot/policy.ts'

const ctx = (extra = {}) => ({
  folder: '/p/My.trekbot',
  secretPaths: ['/data/elevenlabs.json'],
  overrides: {},
  approvals: [],
  ...extra
})
const trek = (name) => `mcp__trek-dev__${name}`
const bash = (command) => ({ tool: 'Bash', input: { command } })

test('free Trek tools are allowed', () => {
  for (const name of ['list_worktrees', 'start_session', 'send_prompt', 'create_worktree', 'start_stack', 'set_worktree_note', 'request_approval']) {
    assert.equal(decide({ tool: trek(name), input: {} }, ctx()).decision, 'allow', name)
  }
})

test('ask-tier Trek tools need approval', () => {
  for (const name of ['close_session', 'unload_worktree', 'promote_to_primary', 'save_session_type', 'delete_session_type']) {
    assert.equal(decide({ tool: trek(name), input: {} }, ctx()).decision, 'ask', name)
  }
})

test('unknown tools default to ask', () => {
  assert.equal(decide({ tool: 'Task', input: {} }, ctx()).decision, 'ask')
  assert.equal(decide({ tool: 'mcp__other__x', input: {} }, ctx()).decision, 'ask')
})

test('ordinary shell commands are allowed', () => {
  assert.equal(decide(bash('git status'), ctx()).decision, 'allow')
})

test('outward-facing shell commands need approval', () => {
  for (const c of ['git push origin main', 'cd x && git push', 'gh pr create -t a', 'gh pr merge 3', 'git worktree remove x']) {
    assert.equal(decide(bash(c), ctx()).decision, 'ask', c)
  }
})

test('force-push and secret reads are denied', () => {
  for (const c of ['git push --force', 'git push -f origin x', 'git push --force-with-lease', 'cat /data/elevenlabs.json']) {
    assert.equal(decide(bash(c), ctx()).decision, 'deny', c)
  }
  assert.equal(decide({ tool: 'Read', input: { file_path: '/data/elevenlabs.json' } }, ctx()).decision, 'deny')
})

test('shell writes to protected bot files are denied', () => {
  for (const c of ['echo x > POLICY.json', 'rm /p/My.trekbot/BOT.md', 'sed -i s/a/b/ state/state.json']) {
    assert.equal(decide(bash(c), ctx()).decision, 'deny', c)
  }
  assert.equal(decide(bash('cat POLICY.json'), ctx()).decision, 'allow')
})

test('file writes follow the folder rules', () => {
  const write = (file_path) => decide({ tool: 'Write', input: { file_path } }, ctx()).decision
  assert.equal(write('/p/My.trekbot/MEMORY.md'), 'allow')
  assert.equal(write('/p/My.trekbot/HEARTBEAT.md'), 'allow')
  assert.equal(write('/p/My.trekbot/knowledge/a.md'), 'allow')
  assert.equal(write('/p/My.trekbot/journal/2026-11-02.md'), 'allow')
  assert.equal(write('/p/My.trekbot/BOT.md'), 'deny')
  assert.equal(write('/p/My.trekbot/POLICY.json'), 'deny')
  assert.equal(write('/p/My.trekbot/config.json'), 'deny')
  assert.equal(write('/p/My.trekbot/state/state.json'), 'deny')
  assert.equal(write('/p/My.trekbot/knowledge/../POLICY.json'), 'deny')
  assert.equal(write('/repo/src/a.ts'), 'ask')
})

test('reads outside secrets are allowed', () => {
  assert.equal(decide({ tool: 'Read', input: { file_path: '/repo/a.ts' } }, ctx()).decision, 'allow')
})

test('overrides move items between free and ask', () => {
  const overrides = { free: [trek('close_session').replace('mcp__trek-dev__', ''), 'bash:git push'], ask: ['start_stack'] }
  assert.equal(decide({ tool: trek('close_session'), input: {} }, ctx({ overrides })).decision, 'allow')
  assert.equal(decide({ tool: trek('start_stack'), input: {} }, ctx({ overrides })).decision, 'ask')
  assert.equal(decide(bash('git push origin x'), ctx({ overrides })).decision, 'allow')
})

test('overrides cannot lift the never tier', () => {
  const overrides = { free: ['bash:git push'] }
  assert.equal(decide(bash('git push --force'), ctx({ overrides })).decision, 'deny')
})

const approval = (tool, input, status = 'approved') => ({ id: 'a1', tool, input, reason: 'r', requestedAt: 1, status })

test('an approved exact call is allowed and reports its approval', () => {
  const result = decide(bash('git push origin x'), ctx({ approvals: [approval('Bash', { command: 'git push origin x' })] }))
  assert.equal(result.decision, 'allow')
  assert.equal(result.approvalId, 'a1')
})

test('a different command or a pending approval is not allowed', () => {
  assert.equal(decide(bash('git push origin y'), ctx({ approvals: [approval('Bash', { command: 'git push origin x' })] })).decision, 'ask')
  assert.equal(decide(bash('git push origin x'), ctx({ approvals: [approval('Bash', { command: 'git push origin x' }, 'pending')] })).decision, 'ask')
})

test('approval matching ignores the Bash description and key order', () => {
  assert.equal(approvalMatches(approval('Bash', { command: 'c' }), { tool: 'Bash', input: { command: 'c', description: 'd' } }), true)
  assert.equal(approvalMatches(approval('X', { a: 1, b: 2 }), { tool: 'X', input: { b: 2, a: 1 } }), true)
})

test('the never tier cannot be approved', () => {
  const result = decide(bash('git push -f'), ctx({ approvals: [approval('Bash', { command: 'git push -f' })] }))
  assert.equal(result.decision, 'deny')
})

test('an ask reason tells the bot how to request approval', () => {
  assert.match(decide(bash('git push'), ctx()).reason, /request_approval/)
})
