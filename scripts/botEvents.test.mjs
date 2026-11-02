import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, parseStreamLine } from '../src/host/bot/events.ts'

const line = (value) => JSON.stringify(value)

test('reads the session id from system init', () => {
  assert.equal(parseStreamLine(line({ type: 'system', subtype: 'init', session_id: 's1' })).sessionId, 's1')
})

test('turns assistant text and tool use into events', () => {
  const parsed = parseStreamLine(line({
    type: 'assistant',
    message: { content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
    ] }
  }))
  assert.deepEqual(parsed.events, [
    { kind: 'text', text: 'Hello' },
    { kind: 'tool', text: 'Bash {"command":"ls"}' }
  ])
})

test('long tool input is shortened', () => {
  const parsed = parseStreamLine(line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Write', input: { content: 'x'.repeat(1000) } }] }
  }))
  assert.ok(parsed.events[0].text.length <= 210)
})

test('reads the result event', () => {
  assert.deepEqual(parseStreamLine(line({ type: 'result', is_error: false, result: 'Done', session_id: 's1' })).result, {
    isError: false,
    text: 'Done'
  })
  assert.deepEqual(parseStreamLine(line({ type: 'result', is_error: true, errors: ['bad'] })).result, {
    isError: true,
    text: 'bad'
  })
})

test('flags a rejected rate limit only', () => {
  assert.equal(parseStreamLine(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })).limited, true)
  assert.equal(parseStreamLine(line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).limited, false)
})

test('ignores malformed lines and other types', () => {
  assert.deepEqual(parseStreamLine('not json').events, [])
  assert.deepEqual(parseStreamLine(line({ type: 'user' })).events, [])
})

test('classifies failures', () => {
  assert.equal(classifyFailure('Not logged in · Please run /login'), 'auth')
  assert.equal(classifyFailure('Invalid API key'), 'auth')
  assert.equal(classifyFailure("You've hit your limit"), 'limit')
  assert.equal(classifyFailure('Usage limit reached'), 'limit')
  assert.equal(classifyFailure('No conversation found with session ID: x'), 'resume')
  assert.equal(classifyFailure('boom'), 'crash')
})
