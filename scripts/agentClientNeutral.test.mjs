// scripts/agentClientNeutral.test.mjs — after plugins A2 the clients know the agents only from their
// server (server.agents with agentInfo, through src/shared/agents/catalog.ts): no agent id, CLI
// folder, adapter import, or agent named in a string or in a component's words, in desktop main and
// preload, the renderer, the web client, src/shared or the phone. Comments may name agents; code
// may not. The agents' own client code is the plugins' (plugins/claude, codex, gemini, grok).
// plugins/ isn't scanned at all, the non-agent plugins (campsite, the ticket and PR plugins…) included.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hits, isAgentCode, scanLines, walk } from './agentScan.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['src/main', 'src/preload', 'src/renderer/src', 'src/web', 'src/shared', 'apps/mobile/src', 'apps/mobile/app']
/** Whole folders left out, each with its reason. */
const SKIP_DIRS = [
  // The phone's demo plays a whole Trek server inside the app (Try the demo), with sample agents: a server's data, not a client's code.
  'apps/mobile/src/demo'
]

/** Whole files allowed, each with its reason. Never add one for a client's UI or rules. */
const ALLOWED_FILES = [
  // The old-server fallback: the agents of a server before agentInfo, as data. Remove with the fallbacks.
  'src/shared/agents/legacyAgents.ts'
]

/**
 * The exceptions, each tied to one file and a narrow line pattern, with the reason it is not agent
 * code in a client. Never add one for UI or rules a client applies to an agent: those come from the
 * server, or belong in the agent's plugin.
 */
const ALLOWED = [
  // The agent every server has and an unknown id resolves to (spec decision 4): the contract names it.
  { file: 'src/shared/plugins/agents.ts', line: /^export const DEFAULT_AGENT_ID = 'claude'$/ },
  // A Global session's role prompt for an agent without its own: prose for the agent, not a list a client parses (A1 revision 21).
  { file: 'src/shared/providers/prompts.ts', line: /^return `You are the global \$\{label\} session of Trek Dev, .*\(Claude Code, Codex, Gemini and others\)/ },
  // A v1 project file's one Global session was Claude's: migrating it keeps the title it had.
  { file: 'src/shared/migration.ts', line: /title: 'Claude' \}\] : \[\]\)$/ },
  // Desktop main's .trekproj importer copies Claude history (spec: out of scope).
  { file: 'src/main/claudeSessionService.ts', line: /^return join\(homedir\(\), '\.claude', 'projects', cwd\.replace/ },
  { file: 'src/main/importer.ts', line: /^import \{ projectDir \} from '\.\/claudeSessionService'$/ },
  // The deleted desktop MCP server's old file: the bot's sandbox keeps it from the bot, and the clean-up removes it by name.
  { file: 'src/main/botSecretFiles.ts', line: /^'global-claude-mcp\.json'$/ },
  { file: 'src/main/staleMcpConfigRules.ts', line: /^return name === 'global-claude-mcp\.json' \|\|/ },
  // The desktop bot runs Claude Code itself (spec: out of scope): its command's default and its panel's words.
  { file: 'src/renderer/src/bot.ts', line: /^claudeCommand: project\.claudeCommand\?\.trim\(\) \|\| 'claude',$/ },
  { file: 'src/renderer/src/components/BotPanel.tsx', line: /^<p>It runs unattended on a heartbeat and uses your Claude usage\./ },
  { file: 'src/renderer/src/components/BotPanel.tsx', line: /^<code>\{claudeCommand\?\.trim\(\) \|\| 'claude'\}<\/code> and your Claude usage\.$/ },
  // The Global panel's stored height keeps its old key, so a user's height survives the rename.
  { file: 'src/renderer/src/components/GlobalSessions.tsx', line: /^const HEIGHT_KEY = 'globalClaudeHeight'$/ }
]

test('no agent code in the clients outside the agent plugins', () => {
  const problems = []
  const used = new Set()
  const usedFiles = new Set()
  for (const dir of DIRS) {
    for (const file of walk(join(root, dir), root, SKIP_DIRS)) {
      const rel = relative(root, file).split(sep).join('/')
      for (const line of scanLines(readFileSync(file, 'utf8'))) {
        if (!isAgentCode(line)) continue
        if (ALLOWED_FILES.includes(rel)) {
          usedFiles.add(rel)
          continue
        }
        const allowed = ALLOWED.find((a) => a.file === rel && a.line.test(line.code.trim()))
        if (allowed) used.add(allowed)
        else problems.push(`${rel}:${line.line}: ${line.code.trim()}`)
      }
    }
  }
  assert.deepEqual(problems, [])
  // An exception that no longer matches anything is stale: drop it rather than let it excuse new code.
  assert.deepEqual(ALLOWED.filter((a) => !used.has(a)).map((a) => a.file), [])
  assert.deepEqual(ALLOWED_FILES.filter((f) => !usedFiles.has(f)), [])
})

test("the check sees a client's agent code, JSX words included, and passes what is not", () => {
  assert.equal(hits("if (meta.llm.provider !== 'claude') showGlyph()").length, 1)
  assert.equal(hits("import { getProvider } from '../../../shared/providers/registry'").length, 1)
  assert.equal(hits("import { CLAUDE_PERMISSION_MODES } from '../../../../shared/providers/claude'").length, 1)
  assert.equal(hits("disabled={pick.provider === 'local' && !pick.model}").length, 1)
  assert.equal(hits('<span className="settings-name">Claude session mode for this project</span>').length, 1, 'an agent named in JSX words')
  assert.equal(hits("const label = `${count} Claude session(s) move`").length, 1)
  assert.equal(hits('<p>Uses <code>x</code> and your Claude usage.</p>').length, 1, 'words after a closing tag (a `</` is no regular expression)')
  assert.equal(hits("<p>It doesn't start Gemini</p>").length, 1, 'an apostrophe in JSX words hides nothing')
  assert.deepEqual(hits("<p>It doesn't start</p>\nconst half = a / 2"), [], 'nor names one')
  assert.equal(hits('<GlobalSessions readOnly={false} />').length, 0)
  assert.equal(hits('const name = catalog.label(llm.provider)').length, 0, "a label from the server's catalog is neutral")
  assert.equal(hits('{/* Claude Code keeps its history in ~/.claude */}').length, 0, 'a JSX comment')
  assert.equal(hits("const fallback = { provider: DEFAULT_AGENT_ID }").length, 0)
})

test('every exception has its reason above it and names one file that exists', () => {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  for (const name of ['const ALLOWED = [', 'const ALLOWED_FILES = [', 'const SKIP_DIRS = [']) {
    const block = text.slice(text.indexOf(name), text.indexOf(']\n', text.indexOf(name)))
    const lines = block.split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
    lines.forEach((line, i) => {
      if (line.startsWith('//')) return
      const before = lines.slice(0, i).reverse().find((l) => !l.startsWith('{ file:') && !l.startsWith("'"))
      assert.ok(before?.startsWith('//'), `no reason above ${line}`)
    })
  }
  for (const a of ALLOWED) assert.ok(existsSync(join(root, a.file)), a.file)
  for (const f of [...ALLOWED_FILES, ...SKIP_DIRS]) assert.ok(existsSync(join(root, f)), f)
})
