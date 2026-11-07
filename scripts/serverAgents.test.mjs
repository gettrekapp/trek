// scripts/serverAgents.test.mjs — server.agents: each provider's command, its program, and the cached installed check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentCommands, commandBinary, CommandProbe, PROBE_TTL_MS } from '../server/src/sessions/agents.ts'
import { DEFAULT_LLM_SETTINGS } from '../src/shared/providers/types.ts'

test('commandBinary skips leading env assignments and blanks', () => {
  assert.equal(commandBinary('claude'), 'claude')
  assert.equal(commandBinary('  /opt/bin/codex --full-auto '), '/opt/bin/codex')
  assert.equal(commandBinary('API_KEY=x OTHER_1=y gemini -y'), 'gemini')
  assert.equal(commandBinary('A=1'), undefined)
  assert.equal(commandBinary('   '), undefined)
})

test('agentCommands: every provider, the server config command, else the default; Claude takes the project\'s claudeCommand', () => {
  const llm = { ...DEFAULT_LLM_SETTINGS, providers: { claude: { command: 'server-claude' }, codex: { command: '  ' }, gemini: { command: 'gem --x' } } }
  assert.deepEqual(agentCommands(llm, undefined), [
    { provider: 'claude', label: 'Claude', command: 'server-claude' },
    { provider: 'codex', label: 'Codex', command: 'codex' },
    { provider: 'gemini', label: 'Gemini', command: 'gem --x' },
    { provider: 'grok', label: 'Grok', command: 'grok' },
    { provider: 'local', label: 'Local', command: 'claude' }
  ])
  assert.equal(agentCommands(llm, { claudeCommand: ' my-claude ' })[0].command, 'my-claude')
  assert.equal(agentCommands(llm, { claudeCommand: '  ' })[0].command, 'server-claude')
})

test('CommandProbe shares a check in flight, reuses it for a minute, and reads a failed check as not installed', async () => {
  const clock = { t: 0 }
  const asked = []
  const probe = new CommandProbe(async (binary) => {
    asked.push(binary)
    if (binary === 'boom') throw new Error('shell failed')
    return binary === 'claude'
  }, () => clock.t)
  const [a, b] = await Promise.all([probe.installed('claude'), probe.installed('claude')])
  assert.deepEqual([a, b, asked], [true, true, ['claude']])
  assert.equal(await probe.installed('codex'), false)
  assert.equal(await probe.installed('boom'), false)
  clock.t = PROBE_TTL_MS - 1
  await probe.installed('claude')
  assert.deepEqual(asked, ['claude', 'codex', 'boom'])
  clock.t = PROBE_TTL_MS
  await probe.installed('claude')
  assert.deepEqual(asked, ['claude', 'codex', 'boom', 'claude'], 'checked again after the TTL')
})

test('CommandProbe starts over past 64 programs', async () => {
  const asked = []
  const probe = new CommandProbe(async (binary) => { asked.push(binary); return true }, () => 0)
  for (let i = 0; i < 64; i++) await probe.installed(`p${i}`)
  await probe.installed('p0')
  assert.equal(asked.length, 64, 'still cached')
  await probe.installed('p64')
  await probe.installed('p0')
  assert.equal(asked.length, 66, 'the cache was cleared for the 65th')
})
