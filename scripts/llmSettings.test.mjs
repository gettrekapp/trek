// scripts/llmSettings.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeLlmSettings, sanitizeLlmSettings } from '../src/shared/providers/settings.ts'

test('sanitize keeps only known providers and known string fields', () => {
  const out = sanitizeLlmSettings({
    llmDefault: { provider: 'codex' },
    providers: {
      codex: { command: 'codex2', approvalMode: '', junk: 1 },
      bogus: { command: 'x' },
      claude: [],
      local: { backend: 'lmstudio', baseUrl: 'http://x', command: 5 },
      gemini: { command: 7 }
    }
  })
  assert.deepEqual(out, {
    llmDefault: { provider: 'codex' },
    providers: {
      codex: { command: 'codex2' },
      local: { backend: 'lmstudio', baseUrl: 'http://x' },
      gemini: {}
    }
  })
})

test('sanitize rejects bad shapes and backends', () => {
  assert.deepEqual(sanitizeLlmSettings(null).providers, {})
  assert.deepEqual(sanitizeLlmSettings({ providers: [] }).providers, {})
  assert.deepEqual(sanitizeLlmSettings({ providers: { local: { backend: 'x', baseUrl: 3 } } }).providers, {
    local: {}
  })
  assert.deepEqual(sanitizeLlmSettings({ llmDefault: 'nope' }).llmDefault, { provider: 'claude' })
})

test('merge sets, deletes fields (undefined) and entries (null)', () => {
  const base = sanitizeLlmSettings({
    llmDefault: { provider: 'claude' },
    providers: { codex: { command: 'a', approvalMode: 'm' }, grok: { command: 'g' } }
  })
  const out = mergeLlmSettings(base, {
    llmDefault: { provider: 'gemini' },
    providers: { codex: { command: undefined }, grok: null, local: { baseUrl: 'http://y' } }
  })
  assert.deepEqual(out, {
    llmDefault: { provider: 'gemini' },
    providers: { codex: { approvalMode: 'm' }, local: { baseUrl: 'http://y' } }
  })
  // base untouched
  assert.equal(base.providers.grok.command, 'g')
})

test('merge keeps other providers and the default when absent from the patch', () => {
  const base = sanitizeLlmSettings({ llmDefault: { provider: 'grok' }, providers: { codex: { command: 'a' } } })
  assert.deepEqual(mergeLlmSettings(base, { providers: { gemini: { command: 'g' } } }), {
    llmDefault: { provider: 'grok' },
    providers: { codex: { command: 'a' }, gemini: { command: 'g' } }
  })
})
