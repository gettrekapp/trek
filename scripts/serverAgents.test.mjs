// scripts/serverAgents.test.mjs — server.agents: each provider's command, its program, and the cached installed check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentCommands, commandBinary, CommandProbe, MAX_PROBES_IN_FLIGHT, platformCommandExists, PROBE_TTL_MS } from '../server/src/sessions/agents.ts'
import { DEFAULT_LLM_SETTINGS } from '../src/shared/providers/types.ts'

test('commandBinary skips leading env assignments and blanks', () => {
  // A POSIX command line (on Windows it is read as one: no env assignments there).
  assert.equal(commandBinary('claude', 'linux'), 'claude')
  assert.equal(commandBinary('  /opt/bin/codex --full-auto ', 'linux'), '/opt/bin/codex')
  assert.equal(commandBinary('API_KEY=x OTHER_1=y gemini -y', 'linux'), 'gemini')
  assert.equal(commandBinary('A=1', 'linux'), undefined)
  assert.equal(commandBinary('   ', 'linux'), undefined)
  assert.equal(commandBinary('"C:\\Program Files\\x\\codex.cmd" --full-auto', 'win32'), 'C:\\Program Files\\x\\codex.cmd')
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

test('CommandProbe runs at most 8 checks at once; the excess reads as not installed and is checked again later', async () => {
  assert.equal(MAX_PROBES_IN_FLIGHT, 8)
  const asked = []
  const release = []
  const probe = new CommandProbe((binary) => {
    asked.push(binary)
    return new Promise((resolve) => release.push(() => resolve(true)))
  }, () => 0)
  const pending = Array.from({ length: 8 }, (_, i) => probe.installed(`p${i}`))
  assert.equal(await probe.installed('extra'), false, 'over the cap')
  assert.equal(asked.length, 8, 'the excess spawned no check')
  const shared = probe.installed('p0')
  assert.equal(asked.length, 8, 'a program already in flight still shares its check')
  for (const r of release) r()
  assert.deepEqual(await Promise.all([...pending, shared]), Array(9).fill(true))
  const later = probe.installed('extra')
  assert.deepEqual(asked.slice(8), ['extra'], 'not cached: checked once there is room')
  release[8]()
  assert.equal(await later, true)
})

test('platformCommandExists on Windows: installed only for what a launch can run, found the way a launch finds it', async () => {
  const on = new Set(['c:\\npm\\codex.cmd', 'c:\\npm\\helper.js', 'c:\\tools\\claude.exe', 'c:\\tools\\run.com', 'c:\\tools\\agent.bat', 'c:\\repo\\bin\\agent.exe'])
  const deps = { env: { Path: 'C:\\npm;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD;.JS' }, isFile: (p) => on.has(p.toLowerCase()) }
  const exists = (b) => platformCommandExists(b, 'win32', deps)
  assert.equal(await exists('codex'), true, 'an npm shim on PATH')
  assert.equal(await exists('claude'), true)
  assert.equal(await exists('run'), true)
  assert.equal(await exists('agent'), true, 'a batch file')
  assert.equal(await exists('C:\\tools\\claude.exe'), true, 'an absolute path')
  assert.equal(await exists('C:/tools/claude'), true, 'an absolute path, PATHEXT tried')
  assert.equal(await exists('helper'), false, 'a .js that PATHEXT names, which a launch refuses')
  assert.equal(await exists('C:\\npm\\helper.js'), false)
  assert.equal(await exists('gemini'), false)
  // A relative head resolves against the session's worktree at launch, which isn't known here.
  assert.equal(await exists('.\\bin\\agent.exe'), false)
  assert.equal(await exists('bin/agent'), false)
  assert.equal(await exists('\\tools\\claude.exe'), false, 'rooted on the current drive')
})
