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
import { LanguageVariant, SyntaxKind as K } from 'typescript/unstable/ast'
import { createScanner } from 'typescript/unstable/ast/scanner'

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

/** Trivia: never code. Comments are blanked out (their newlines kept, so line numbers hold). */
const TRIVIA = new Set([K.WhitespaceTrivia, K.NewLineTrivia, K.ConflictMarkerTrivia, K.NonTextFileMarkerTrivia, K.ShebangTrivia])
const COMMENTS = new Set([K.SingleLineCommentTrivia, K.MultiLineCommentTrivia])
/** Tokens whose text is a string's: quotes, and every part of a template literal. */
const STRINGS = new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead, K.TemplateMiddle, K.TemplateTail])
/** A `/` after one of these divides; anywhere else it starts a regular expression (scanned whole). */
const ENDS_EXPRESSION = new Set([
  K.Identifier, K.NumericLiteral, K.BigIntLiteral, K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateTail,
  K.RegularExpressionLiteral, K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken, K.ThisKeyword,
  K.SuperKeyword, K.TrueKeyword, K.FalseKeyword, K.NullKeyword, K.PlusPlusToken, K.MinusMinusToken
])

/**
 * The file as lines, scanned with TypeScript's scanner: `code` is each line with its comments blanked
 * (strings, templates and identifiers kept as written), `strings` the parts of string and template
 * tokens on that line (a multi-line template gives each of its lines its own part). Without a parser,
 * a `}` closes a template's `${` when no `{` of its own is open, and a `/` is a regular expression
 * unless it follows an operand. JSX text is not told apart: the scanned folders hold no .tsx today.
 */
function scanLines(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  const lineOf = (pos) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const strings = starts.map(() => [])
  let code = ''
  let copied = 0
  const scanner = createScanner(false, LanguageVariant.Standard, text)
  const templates = [] // per open `${`: how many of its own `{` are open
  let prev = K.Unknown
  for (let kind = scanner.scan(); kind !== K.EndOfFile; kind = scanner.scan()) {
    if (kind === K.OpenBraceToken && templates.length) templates[templates.length - 1]++
    else if (kind === K.CloseBraceToken && templates.length) {
      if (templates[templates.length - 1] === 0) {
        kind = scanner.reScanTemplateToken(false)
        if (kind === K.TemplateTail) templates.pop()
      } else templates[templates.length - 1]--
    } else if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && !ENDS_EXPRESSION.has(prev)) kind = scanner.reScanSlashToken()
    if (kind === K.TemplateHead) templates.push(0)
    const start = scanner.getTokenStart()
    const end = scanner.getTokenEnd()
    if (COMMENTS.has(kind)) {
      code += text.slice(copied, start) + text.slice(start, end).replace(/[^\r\n]/g, ' ')
      copied = end
      continue
    }
    if (TRIVIA.has(kind)) continue
    prev = kind
    if (!STRINGS.has(kind)) continue
    for (let line = lineOf(start); line <= lineOf(Math.max(start, end - 1)); line++) {
      strings[line].push(text.slice(Math.max(start, starts[line]), Math.min(end, starts[line + 1] ?? end)))
    }
  }
  code += text.slice(copied)
  return code.split('\n').map((line, i) => ({ line: i + 1, code: line.replace(/\r$/, ''), strings: strings[i] }))
}

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
  /['"`](claude|codex|gemini|grok)['"`]|\.claude\b|\.codex\b|\.gemini\b|\.claude\.json|CODEX_HOME|CLAUDE_CONFIG_DIR|ANTHROPIC_|GEMINI_CLI|shared\/providers\/(registry|selection|settings|claude|codex|gemini|grok|local)\b|claudeSessionService|skillService|externalConfig|discoverCodexSession|plugins\/(claude|codex|gemini|grok)\/|\bPROVIDER_IDS\b|\bgetProvider\b|\bisProviderId\b|provider\s*[!=]==\s*['"`]local/

/** An agent's name anywhere inside a string: a key, a message, a path or prose that names it. */
const AGENT_NAME = /claude|codex|gemini|grok|anthropic/i

const isAgentCode = ({ code, strings }) => AGENT_CODE.test(code) || strings.some((s) => AGENT_NAME.test(s))
/** The lines of `text` the check flags, as `line: code`. */
const hits = (text) => scanLines(text).filter(isAgentCode).map((l) => `${l.line}: ${l.code.trim()}`)

test('no agent code in the server or the host services outside the agent plugins', () => {
  const problems = []
  const used = new Set()
  for (const dir of DIRS) {
    for (const file of walk(join(root, dir))) {
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
