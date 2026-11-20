// scripts/agentScan.mjs — the agent-name scan the guards share (plugins A1: agentNeutral.test.mjs,
// the server; plugins A2: agentClientNeutral.test.mjs, the clients). A file is read with
// TypeScript's scanner: comments are blanked, strings and template parts are kept per line, and so
// are identifiers (JSX text scans as identifiers, so an agent named in a component's words is seen).
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { LanguageVariant, SyntaxKind as K } from 'typescript/unstable/ast'
import { createScanner } from 'typescript/unstable/ast/scanner'

const SKIP = new Set(['node_modules', 'dist', 'out'])

/** Every .ts/.tsx file under `dir` (not generated ones), leaving out `skipDirs` (repo-relative, with `/`). */
export function* walk(dir, root, skipDirs = []) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    const rel = relative(root, path).split(sep).join('/')
    if (skipDirs.includes(rel)) continue
    if (statSync(path).isDirectory()) yield* walk(path, root, skipDirs)
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
 * tokens on that line (a multi-line template gives each of its lines its own part), `names` its
 * identifiers. Without a parser,
 * a `}` closes a template's `${` when no `{` of its own is open, and a `/` is a regular expression
 * unless it follows an operand or opens a JSX closing tag (`</`). JSX text is not told apart from
 * code: its words scan as identifiers, which is how an agent named there is seen (AGENT_PROPER). A
 * quote in JSX text opens a string to the line's end, whose words are still checked; a `//` in JSX
 * text (a URL) hides the rest of its line.
 */
export function scanLines(text) {
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
  const names = starts.map(() => [])
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
    } else if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && !ENDS_EXPRESSION.has(prev) && prev !== K.LessThanToken) kind = scanner.reScanSlashToken()
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
    if (kind === K.Identifier) names[lineOf(start)].push(text.slice(start, end))
    if (!STRINGS.has(kind)) continue
    for (let line = lineOf(start); line <= lineOf(Math.max(start, end - 1)); line++) {
      strings[line].push(text.slice(Math.max(start, starts[line]), Math.min(end, starts[line + 1] ?? end)))
    }
  }
  code += text.slice(copied)
  return code.split('\n').map((line, i) => ({ line: i + 1, code: line.replace(/\r$/, ''), strings: strings[i], names: names[i] }))
}

/**
 * An agent's id as a string, its CLI's folders, files and env variables, the static adapter table and
 * the adapters, and the Claude history and skills modules that moved into the claude plugin.
 */
export const AGENT_CODE =
  /['"`](claude|codex|gemini|grok)['"`]|\.claude\b|\.codex\b|\.gemini\b|\.claude\.json|CODEX_HOME|CLAUDE_CONFIG_DIR|ANTHROPIC_|GEMINI_CLI|shared\/providers\/(registry|selection|settings|claude|codex|gemini|grok|local)\b|claudeSessionService|skillService|externalConfig|discoverCodexSession|plugins\/(claude|codex|gemini|grok)\/|\bPROVIDER_IDS\b|\bgetProvider\b|\bisProviderId\b|provider\s*[!=]==\s*['"`]local/

/** An agent's name anywhere inside a string: a key, a message, a path or prose that names it. */
export const AGENT_NAME = /claude|codex|gemini|grok|anthropic/i

/** An identifier that is exactly an agent's name: JSX text ("Claude session mode"), never a real identifier in core. */
export const AGENT_PROPER = /^(Claude|Codex|Gemini|Grok|Anthropic)$/

export const isAgentCode = ({ code, strings, names }) => AGENT_CODE.test(code) || strings.some((s) => AGENT_NAME.test(s)) || names.some((n) => AGENT_PROPER.test(n))
/** The lines of `text` the check flags, as `line: code`. */
export const hits = (text) => scanLines(text).filter(isAgentCode).map((l) => `${l.line}: ${l.code.trim()}`)
