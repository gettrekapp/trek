// scripts/agentNeutral.test.mjs — after plugins A1, the agents live in plugins/claude, codex, gemini
// and grok on the server's side: no agent id, CLI folder, CLI env variable, Claude history or
// adapter import in the server's code (server/src) or the host services (src/host). Comments may
// name agents; code may not. The desktop bot (src/host/bot) is Claude's and stays core (spec, out of
// scope). The client half (the renderer, the web client, src/shared and the phone) follows in A2,
// with this check widened to them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['server/src', 'src/host']
/** Whole folders left out, each with its reason. */
const SKIP_DIRS = [
  // The desktop bot runs Claude Code itself, from desktop main; it stays core (plugins A1 spec, out of scope).
  'src/host/bot'
]
const SKIP = new Set(['node_modules', 'dist', 'out'])

function* walk(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    const rel = relative(root, path).split(sep).join('/')
    if (SKIP_DIRS.includes(rel)) continue
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.generated.ts')) yield path
  }
}

/** The file's text without // and /* *\/ comments (good enough for this check, as in colimaNeutral.test.mjs). */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')

/**
 * The exceptions, each tied to one file and a narrow line pattern, with the reason it is not agent
 * code on the server. Never add one for code the server runs for an agent: that belongs in its plugin.
 */
const ALLOWED = [
  // Desktop main's .trekproj importer copies Claude history (spec: out of scope); the server never imports this file.
  { file: 'src/host/claudeSessionService.ts', line: /^return join\(homedir\(\), '\.claude', 'projects', cwd\.replace/ },
  // The claude plugin's project settings keep the names core gave them (revision 2): core lists them as
  // plugin-owned so its own SETTINGS_KINDS no longer takes them; it never reads their values.
  { file: 'server/src/projects/settings.ts', line: /^export const PLUGIN_OWNED_SETTINGS = \[.*'claudeCommand', 'claudeArgs', 'claudePermissionMode'\] as const$/ },
  // MCP prose for agents, not a list a client parses (revision 21): the server instructions name the agents a session can run.
  { file: 'server/src/mcp/tools.ts', line: /^"Controls this Trek project on the Trek server; .*\(Claude, Codex, Gemini, Grok or a local model\)/ },
  // MCP prose: promote_to_primary's description says which sessions follow the branch (the agents with history.migrate).
  { file: 'server/src/mcp/tools.ts', line: /^"Ask the user to promote a worktree to the primary checkout: .*Its Claude and local-model sessions move to the main checkout and resume; others are closed\./ },
  // MCP prose: the queued prompt a promoted session reads afterwards, in the same words as the description.
  { file: 'server/src/mcp/tools.ts', line: /^\? `The promote you asked for \(promote_to_primary\) went through: .*the worktree's Claude and local-model sessions/ },
  // The external MCP client starts the servers Claude Code's config names (the claude plugin lists them, Task 13);
  // its errors tell the user where the approval and the sign-in live. It runs no agent and reads no agent folder.
  { file: 'server/src/mcp/externalClient.ts', line: /^if \(spec\.unapproved\) throw new Error\('not approved in Claude Code for this project, so Trek does not start it'\)$/ },
  { file: 'server/src/mcp/externalClient.ts', line: /^throw new Error\('needs a sign-in \(Claude Code signs in with OAuth; Trek cannot\)'\)$/ }
]

/**
 * An agent's id as a string, its CLI's folders, files and env variables, the static adapter table and
 * the adapters, and the Claude history and skills modules that moved into the claude plugin.
 */
const AGENT_CODE =
  /['"`](claude|codex|gemini|grok)['"`]|\.claude\b|\.codex\b|\.gemini\b|\.claude\.json|CODEX_HOME|CLAUDE_CONFIG_DIR|ANTHROPIC_|GEMINI_CLI|shared\/providers\/(registry|selection|settings|claude|codex|gemini|grok|local)\b|claudeSessionService|skillService|externalConfig|discoverCodexSession|plugins\/(claude|codex|gemini|grok)\//

/** A string literal on one line (quotes, or a one-line template). */
const STRING = /(['"`])(?:\\.|(?!\1).)*\1/g
/** An agent's name anywhere inside a string: a key, a message, a path or prose that names it. */
const AGENT_NAME = /claude|codex|gemini|grok|anthropic/i

const isAgentCode = (line) => AGENT_CODE.test(line) || (line.match(STRING) ?? []).some((s) => AGENT_NAME.test(s))

test('no agent code in the server or the host services outside the agent plugins', () => {
  const problems = []
  const used = new Set()
  for (const dir of DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file).split(sep).join('/')
      code(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (!isAgentCode(line)) return
          const allowed = ALLOWED.find((a) => a.file === rel && a.line.test(line.trim()))
          if (allowed) return void used.add(allowed)
          problems.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
    }
  }
  assert.deepEqual(problems, [])
  // An exception that no longer matches anything is stale: drop it rather than let it excuse new code.
  assert.deepEqual(ALLOWED.filter((a) => !used.has(a)).map((a) => a.file), [])
})

test('the check sees the agent code it must catch, and passes what is not', () => {
  const hits = (text) => code(text).split('\n').filter(isAgentCode)
  assert.equal(hits("if (session.llm.provider !== 'claude') return null").length, 1)
  assert.equal(hits("const root = join(homedir(), '.codex', 'sessions')").length, 1)
  assert.equal(hits("env: { ANTHROPIC_BASE_URL: url }").length, 1)
  assert.equal(hits("import { getProvider } from '../../../src/shared/providers/registry.ts'").length, 1)
  assert.equal(hits("import { projectDir } from '../../../src/host/claudeSessionService.ts'").length, 1)
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
