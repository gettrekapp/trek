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
    text: 'Done',
    apiStatus: null
  })
  assert.deepEqual(parseStreamLine(line({ type: 'result', is_error: true, errors: ['bad'] })).result, {
    isError: true,
    text: 'bad',
    apiStatus: null
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

test('reads a numeric api_error_status on the result', () => {
  assert.equal(parseStreamLine(line({ type: 'result', is_error: true, result: 'x', api_error_status: 401 })).result.apiStatus, 401)
  assert.equal(parseStreamLine(line({ type: 'result', is_error: true, result: 'x', api_error_status: '401' })).result.apiStatus, null)
  assert.equal(parseStreamLine(line({ type: 'result', is_error: true, result: 'x' })).result.apiStatus, null)
})

test('result text uses result only when a string, else string errors, else empty', () => {
  assert.equal(parseStreamLine(line({ type: 'result', result: 5, errors: ['a', 3, 'b'] })).result.text, 'a\nb')
  assert.equal(parseStreamLine(line({ type: 'result', result: null })).result.text, '')
  assert.equal(parseStreamLine(line({ type: 'result', errors: 'nope' })).result.text, '')
})

test('unexpected json shapes never throw', () => {
  for (const raw of ['null', '5', '[]', '"s"', line({ type: 'assistant', message: { content: 5 } }), line({ type: 'assistant', message: { content: [null] } }), line({ type: 'assistant', message: null })]) {
    assert.deepEqual(parseStreamLine(raw).events, [])
  }
})

test('only string fields are used', () => {
  assert.equal(parseStreamLine(line({ type: 'system', subtype: 'init', session_id: 5 })).sessionId, undefined)
  const parsed = parseStreamLine(line({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 5 },
      { type: 'tool_use', input: {} },
      { type: 'tool_use', name: 7 },
      { type: 'tool_use', name: 'Bash' }
    ] }
  }))
  assert.deepEqual(parsed.events, [{ kind: 'tool', text: 'Bash {}' }])
})

test('classifies auth, limit, and crash texts', () => {
  const auth = [
    'Invalid auth token · Fix external auth token',
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Failed to authenticate: OAuth token revoked. Please log in again'
  ]
  const limit = [
    "You've reached your Fable limit.",
    "You've hit your monthly spend limit.",
    "You've hit your team's shared budget",
    "You're out of usage credits",
    'You\u2019ve hit your limit'
  ]
  const crash = [
    'Tool failed: could not reach the authentication service, ECONNRESET',
    'Cannot find module ./api/login',
    'See src/routes/login.ts',
    'hook: /usr/bin/login-helper failed',
    'Crash in rate limiter module',
    'Context limit reached',
    'Reached maximum number of turns (1)',
    'Reached maximum budget ($5)'
  ]
  for (const t of auth) assert.equal(classifyFailure(t), 'auth', t)
  for (const t of limit) assert.equal(classifyFailure(t), 'limit', t)
  for (const t of crash) assert.equal(classifyFailure(t), 'crash', t)
})

test('api status wins and lines are tested individually', () => {
  assert.equal(classifyFailure('anything', 401), 'auth')
  assert.equal(classifyFailure('anything', 429), 'limit')
  assert.equal(classifyFailure('boom', 500), 'crash')
  assert.equal(classifyFailure('starting\nNot logged in'), 'auth')
})
