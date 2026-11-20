// scripts/agentNeutral.test.mjs — after plugins A1, the agents live in plugins/claude, codex, gemini
// and grok on the server's side: no agent id, CLI folder, CLI env variable, Claude history or
// adapter import in the server's code (server/src) or the host services (src/host). Comments may
// name agents; code may not. The desktop bot (src/host/bot) is Claude's and stays core (spec, out of
// scope). The clients have their own check since plugins A2
// (agentClientNeutral.test.mjs), sharing this scan (agentScan.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hits, isAgentCode, scanLines, walk } from './agentScan.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['server/src', 'src/host']
/** Whole folders left out, each with its reason. */
const SKIP_DIRS = [
  // The desktop bot runs Claude Code itself, from desktop main; it stays core (plugins A1 spec, out of scope).
  'src/host/bot'
]
/**
 * The exceptions, each tied to one file and a narrow line pattern, with the reason it is not agent
 * code on the server. Never add one for code the server runs for an agent: that belongs in its plugin.
 */
const ALLOWED = [
  // The claude plugin's project settings keep the names core gave them (revision 2): core lists them as
  // plugin-owned so its own SETTINGS_KINDS no longer takes them; it never reads their values.
  { file: 'server/src/projects/settings.ts', line: /^export const PLUGIN_OWNED_SETTINGS = \[.*'claudeCommand', 'claudeArgs', 'claudePermissionMode'\] as const$/ },
  // MCP prose for agents, not a list a client parses (revision 21): the server instructions name the agents a session can run.
  { file: 'server/src/mcp/tools.ts', line: /^"Controls this Trek project on the Trek server; .*\(Claude, Codex, Gemini, Grok or a local model\)/ },
  // MCP prose: promote_to_primary's description says which sessions follow the branch (the agents with history.migrate).
  { file: 'server/src/mcp/tools.ts', line: /^"Ask the user to promote a worktree to the primary checkout: .*Its Claude and local-model sessions move to the main checkout and resume; others are closed\./ },
  // MCP prose: the queued prompt a promoted session reads afterwards, in the same words as the description.
  { file: 'server/src/mcp/tools.ts', line: /^\? `The promote you asked for \(promote_to_primary\) went through: .*the worktree's Claude and local-model sessions/ }
]

test('no agent code in the server or the host services outside the agent plugins', () => {
  const problems = []
  const used = new Set()
  for (const dir of DIRS) {
    for (const file of walk(join(root, dir), root, SKIP_DIRS)) {
      const rel = relative(root, file).split(sep).join('/')
      for (const line of scanLines(readFileSync(file, 'utf8'))) {
        if (!isAgentCode(line)) continue
        const allowed = ALLOWED.find((a) => a.file === rel && a.line.test(line.code.trim()))
        if (allowed) used.add(allowed)
        else problems.push(`${rel}:${line.line}: ${line.code.trim()}`)
      }
    }
  }
  assert.deepEqual(problems, [])
  // An exception that no longer matches anything is stale: drop it rather than let it excuse new code.
  assert.deepEqual(ALLOWED.filter((a) => !used.has(a)).map((a) => a.file), [])
})

test('the check sees the agent code it must catch, and passes what is not', () => {
  assert.equal(hits("if (session.llm.provider !== 'claude') return null").length, 1)
  assert.equal(hits("const root = join(homedir(), '.codex', 'sessions')").length, 1)
  assert.equal(hits("env: { ANTHROPIC_BASE_URL: url }").length, 1)
  assert.equal(hits("import { getProvider } from '../../../src/shared/providers/registry.ts'").length, 1)
  assert.equal(hits("import { projectDir } from '../../../src/main/claudeSessionService.ts'").length, 1)
  assert.equal(hits('// Claude Code keeps its history in ~/.claude').length, 0, 'comments may name them')
  assert.equal(hits('const value = settings.claudeCommand').length, 0, "the claude plugin's setting names are not agent code")
  assert.equal(hits("if (token === 'local') refuse()").length, 0, "the local server's token is not the Local agent")
  assert.equal(hits("import { pickClaimant } from '../../../src/shared/providers/discovery.ts'").length, 0, 'the neutral discovery rules')
  assert.equal(hits("import { claudeServerPlugin } from '../../plugins/claude/server/index.ts'").length, 1, 'core never imports an agent plugin')
  assert.equal(hits("if (settings.claudePermissionMode === 'plan') args.push('--permission-mode', 'plan')").length, 0, 'a setting name alone is not')
  assert.equal(hits("const keys = ['claudeCommand', 'claudeArgs']").length, 1, 'but core naming the keys is')
  assert.equal(hits("throw new Error('Claude Code is not installed')").length, 1, 'an agent named in a message')
  assert.equal(hits('const label = `${agent.label} is turned off for this project`').length, 0, 'a label from the agent is neutral')
  assert.equal(hits('{/* Gemini reads its own file */}').length, 0, 'a JSX comment too')
})

test('the scanner reads strings, templates and comments as TypeScript does, and keeps line numbers', () => {
  assert.deepEqual(hits("const glob = 'src/*.ts'\nconst id = 'codex'"), ["2: const id = 'codex'"], "a /* inside a string opens no comment")
  assert.deepEqual(hits("const glob = 'src/*.ts'; const id = 'codex'"), ["1: const glob = 'src/*.ts'; const id = 'codex'"], 'nor on its own line')
  assert.deepEqual(hits("const url = 'https://x'; if (p === 'gemini') go()"), ["1: const url = 'https://x'; if (p === 'gemini') go()"], 'a // inside a string hides nothing')
  assert.deepEqual(hits("const sep = '//'; run('grok')"), ["1: const sep = '//'; run('grok')"])
  assert.deepEqual(hits('const text = `first line\nClaude Code is missing\nlast`'), ['2: Claude Code is missing'], "a template's continuation lines are checked, each at its own line")
  assert.deepEqual(hits('const text = `${a}\n${b} then Codex ${c}`'), ['2: ${b} then Codex ${c}`'], 'between substitutions too')
  assert.deepEqual(hits('const text = `${({ a: 1 }).a} Gemini`'), ['1: const text = `${({ a: 1 }).a} Gemini`'], "a { inside ${} does not end the template's tracking")
  assert.deepEqual(hits("/*\n * Claude\n * Codex\n */\nconst a = 1\nrun('grok')"), ["6: run('grok')"], 'line numbers hold after a multi-line block comment')
  assert.deepEqual(hits("const re = /['\"]/g\nconst b = 'ok'"), [], 'a quote inside a regular expression starts no string')
  assert.deepEqual(hits("const half = a / 2; const b = c / 3 // 'claude'"), [], 'a division is not a regular expression')
  assert.deepEqual(hits("const text = 'a // b'; // Claude"), [], 'a real comment after a string is still a comment')
  assert.equal(hits('for (const id of PROVIDER_IDS) use(id)').length, 1, 'the old static id list')
  assert.equal(hits('const p = getProvider(session.llm.provider)').length, 1, 'the old static lookup')
  assert.equal(hits('if (!isProviderId(value)) throw bad()').length, 1, 'the old static id check')
  assert.equal(hits("if (session.llm.provider === 'local') return url").length, 1, 'the Local agent by its id')
  assert.equal(hits('if (provider !== "local") return').length, 1)
  assert.equal(hits('const providerIds = registry.ids()').length, 0, 'a neutral name alone is not')
})

test('every exception has its reason above it and names one file', () => {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const block = text.slice(text.indexOf('const ALLOWED = ['), text.indexOf(']\n', text.indexOf('const ALLOWED = [')))
  const lines = block.split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
  lines.forEach((line, i) => {
    if (!line.startsWith('{ file:')) return
    const before = lines.slice(0, i).reverse().find((l) => !l.startsWith('{ file:'))
    assert.ok(before?.startsWith('//'), `no reason above ${line}`)
  })
  for (const a of ALLOWED) assert.ok(existsSync(join(root, a.file)), a.file)
})
