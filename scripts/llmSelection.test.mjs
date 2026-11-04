// scripts/llmSelection.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  describeLlm,
  effectiveEffort,
  effortsFor,
  persistedLlm,
  resolveGlobalLlm,
  resolveNewSessionLlm,
  sanitizeLlmSelection,
  sanitizeProjectLlm,
  sessionsAfterMove,
  sessionMigrates
} from '../src/shared/providers/selection.ts'

test('resolution order: pick > session type > project > app > claude', () => {
  const pick = { provider: 'gemini' }
  const type = { provider: 'codex' }
  const proj = { provider: 'local', model: 'm' }
  const app = { provider: 'grok' }
  assert.deepEqual(resolveNewSessionLlm({ pick, sessionType: type, projectDefault: proj, appDefault: app }), pick)
  assert.deepEqual(resolveNewSessionLlm({ sessionType: type, projectDefault: proj, appDefault: app }), type)
  assert.deepEqual(resolveNewSessionLlm({ projectDefault: proj, appDefault: app }), proj)
  assert.deepEqual(resolveNewSessionLlm({ appDefault: app }), app)
  assert.deepEqual(resolveNewSessionLlm({}), { provider: 'claude' })
})

test('a selection resolves as a whole unit', () => {
  const resolved = resolveNewSessionLlm({
    sessionType: { provider: 'codex' },
    appDefault: { provider: 'claude', model: 'opus', effort: 'high' }
  })
  assert.deepEqual(resolved, { provider: 'codex' })
})

test('sanitize: unknown provider is claude, blanks dropped, non-objects undefined', () => {
  assert.equal(sanitizeLlmSelection(undefined), undefined)
  assert.equal(sanitizeLlmSelection('codex'), undefined)
  assert.deepEqual(sanitizeLlmSelection({ provider: 'gpt', model: 'x' }), { provider: 'claude' })
  assert.deepEqual(sanitizeLlmSelection({ provider: 'codex', model: ' ', effort: 3 }), { provider: 'codex' })
  assert.deepEqual(sanitizeLlmSelection({ provider: 'codex', model: 'gpt-5', effort: 'low' }), {
    provider: 'codex',
    model: 'gpt-5',
    effort: 'low'
  })
})

test('effort: kept only when the model offers it', () => {
  assert.deepEqual(effortsFor({ provider: 'claude', model: 'haiku' }), [])
  assert.equal(effectiveEffort({ provider: 'claude', model: 'opus', effort: 'max' }), 'max')
  assert.equal(effectiveEffort({ provider: 'claude', model: 'haiku', effort: 'max' }), undefined)
  assert.equal(effectiveEffort({ provider: 'claude', effort: 'xhigh' }), 'xhigh')
  assert.equal(effectiveEffort({ provider: 'claude', model: 'claude-custom-1', effort: 'low' }), 'low')
  assert.equal(effectiveEffort({ provider: 'claude', effort: 'bogus' }), undefined)
  assert.equal(effectiveEffort({ provider: 'gemini', effort: 'high' }), undefined)
})

test('describe', () => {
  assert.equal(describeLlm({ provider: 'claude' }), 'Claude')
  assert.equal(describeLlm({ provider: 'claude', model: 'opus', effort: 'high' }), 'Claude · opus · high')
  assert.equal(describeLlm({ provider: 'gemini', effort: 'high' }), 'Gemini')
})

test('global: only MCP-capable providers', () => {
  assert.deepEqual(resolveGlobalLlm({ provider: 'grok' }, { provider: 'codex' }), { provider: 'codex' })
  assert.deepEqual(resolveGlobalLlm({ provider: 'grok' }, { provider: 'grok' }), { provider: 'claude' })
  assert.deepEqual(resolveGlobalLlm(undefined, { provider: 'gemini' }), { provider: 'gemini' })
  assert.deepEqual(resolveGlobalLlm({ provider: 'local', model: 'm' }, undefined), { provider: 'local', model: 'm' })
})

test('sessionMigrates: Claude and Local (and legacy) only', () => {
  assert.equal(sessionMigrates({ title: 't', sessionId: 's' }), true)
  assert.equal(sessionMigrates({ title: 't', sessionId: 's', llm: { provider: 'local' } }), true)
  assert.equal(sessionMigrates({ title: 't', sessionId: 's', llm: { provider: 'codex' } }), false)
})

test('sanitizeProjectLlm cleans every place a selection lives', () => {
  const project = {
    name: 'p',
    llmDefault: { provider: 'nope' },
    globalLlm: 'bad',
    sessionTypes: [{ id: 't', name: 'T', systemPrompt: '', llm: { provider: 'codex', model: '' } }],
    globalSessions: [{ sessionId: 'g', title: 'G', llm: { provider: 'x' } }],
    repositories: [
      {
        id: 'r',
        worktrees: [{ id: 'w', terminals: [{ title: 'a', sessionId: 's', llm: { provider: 'gemini', effort: 7 } }] }],
        primaryTerminals: [{ title: 'b', sessionId: 's2', llm: null }]
      }
    ]
  }
  const clean = sanitizeProjectLlm(project)
  assert.deepEqual(clean.llmDefault, { provider: 'claude' })
  assert.equal('globalLlm' in clean, false)
  assert.deepEqual(clean.sessionTypes[0].llm, { provider: 'codex' })
  assert.deepEqual(clean.globalSessions[0].llm, { provider: 'claude' })
  assert.deepEqual(clean.repositories[0].worktrees[0].terminals[0].llm, { provider: 'gemini' })
  assert.equal('llm' in clean.repositories[0].primaryTerminals[0], false)
})

test('sanitizeProjectLlm does not throw on malformed input', () => {
  assert.doesNotThrow(() => sanitizeProjectLlm({ sessionTypes: [null] }))
  assert.deepEqual(sanitizeProjectLlm({ sessionTypes: [null] }), { sessionTypes: [null] })
  assert.deepEqual(sanitizeProjectLlm({ sessionTypes: {} }), { sessionTypes: {} })
  const p = { repositories: [{ worktrees: [null] }] }
  assert.deepEqual(sanitizeProjectLlm(p), p)
})

test('persistedLlm drops only plain Claude', () => {
  assert.equal(persistedLlm(undefined), undefined)
  assert.equal(persistedLlm({ provider: 'claude' }), undefined)
  assert.equal(persistedLlm({ provider: 'claude', model: undefined, effort: undefined }), undefined)
  assert.deepEqual(persistedLlm({ provider: 'claude', model: 'opus' }), { provider: 'claude', model: 'opus' })
  assert.deepEqual(persistedLlm({ provider: 'claude', effort: 'high' }), { provider: 'claude', effort: 'high' })
  assert.deepEqual(persistedLlm({ provider: 'codex' }), { provider: 'codex' })
  assert.deepEqual(persistedLlm({ provider: 'local', model: 'qwen' }), { provider: 'local', model: 'qwen' })
})

test('sessionsAfterMove keeps migratable sessions whole, minus their pty id', () => {
  const claude = { title: 'A', sessionId: 's1', ptyId: 'p1', systemPrompt: 'SP', sessionTypeId: 't', queue: ['q1', 'q2'] }
  const codex = { title: 'B', sessionId: 's2', llm: { provider: 'codex' }, systemPrompt: 'X' }
  assert.deepEqual(sessionsAfterMove([claude, codex]), [
    { title: 'A', sessionId: 's1', systemPrompt: 'SP', sessionTypeId: 't', queue: ['q1', 'q2'] }
  ])
  const local = { title: 'L', sessionId: 's3', llm: { provider: 'local', model: 'm' } }
  assert.deepEqual(sessionsAfterMove([local]), [local])
})
