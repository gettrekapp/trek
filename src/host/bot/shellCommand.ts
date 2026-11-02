import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'

/**
 * Best-effort reading of a shell command for the bot's policy. It tokenises like
 * a shell for quotes, separators and redirects, and knows the handful of commands
 * the policy cares about. It is not a shell parser, and a disguised command gets
 * past it by design.
 */

// Stand-ins for unquoted wildcards, so a path keeps them through resolve().
const ANY = ''
const ONE = ''

export interface Word {
  /** The value after quote removal. */
  text: string
  /** The same, with unquoted wildcards replaced by stand-ins. */
  glob: string
}

export interface Segment {
  words: Word[]
  redirects: Word[]
  /** The directory this segment runs in. */
  cwd: string
}

export interface ShellAnalysis {
  forcePush: boolean
  /** Ask-tier override keys, without the `bash:` prefix. */
  ask: string[]
  /** Absolute paths really written. They can hold wildcards: compare with couldMatch. */
  writes: string[]
  /** Absolute paths removed, moved away or recursively changed as a whole. */
  destroys: string[]
  /** Every word as an absolute path, plus the value of `x=value` and `@value`. */
  paths: string[]
}

type RawSegment = Pick<Segment, 'words' | 'redirects'>
type ScanItem = RawSegment | '(' | ')'

const MAX_NESTING = 8
const MAX_COMMAND_LENGTH = 64 * 1024
const MAX_SEGMENTS = 2000

function checkNesting(depth: number): void {
  if (depth > MAX_NESTING) throw new Error('Shell command is too deeply nested to analyse.')
}

/** Skips a heredoc body. `i` is the newline before it; returns the newline after its tag. */
function skipHeredoc(s: string, i: number, tag: string): number {
  for (let line = null; line !== tag && i < s.length; ) {
    const nl = s.indexOf('\n', i + 1)
    const stop = nl < 0 ? s.length : nl
    line = s.slice(i + 1, stop).trim()
    i = stop
  }
  return i
}

/** The closing `'` of a `$'...'` whose body starts at `start`. */
function ansiQuoteEnd(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === "'") return i
  }
  return s.length
}

/** The closing backtick of a substitution whose body starts at `start`. */
function backtickEnd(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === '`') return i
  }
  return s.length
}

/** The last `)` of an arithmetic `$((...))` at `start`, or -1 when it's a substitution. */
function arithmeticEnd(s: string, start: number): number {
  if (!s.startsWith('$((', start)) return -1
  let depth = 0
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) {
      const body = s.slice(start + 3, i)
      return s[i - 1] === ')' && !body.includes('$(') && !body.includes('`') ? i : -1
    }
  }
  return -1
}

const HEREDOC_TAG = /-?[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|()<>'"]+))/y

/** The `)` closing a `$(` whose body starts at `start`, past quotes, heredocs and inner substitutions. */
function substitutionEnd(s: string, start: number, depth: number): number {
  checkNesting(depth)
  let parens = 0
  let quote = ''
  const heredocs: string[] = []
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (quote === "'") {
      if (c === "'") quote = ''
    } else if (c === '\\') {
      i++
    } else if (c === '`') {
      i = backtickEnd(s, i + 1)
    } else if (c === '$' && s[i + 1] === '(') {
      const arithmetic = arithmeticEnd(s, i)
      i = arithmetic >= 0 ? arithmetic : substitutionEnd(s, i + 2, depth + 1)
    } else if (c === '"') {
      quote = quote ? '' : '"'
    } else if (quote) {
      continue
    } else if (c === '$' && s[i + 1] === "'") {
      i = ansiQuoteEnd(s, i + 2)
    } else if (c === "'") {
      quote = c
    } else if (c === '#' && (i === start || /\s/.test(s[i - 1]))) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++
    } else if (c === '(') {
      parens++
    } else if (c === ')') {
      if (parens-- === 0) return i
    } else if (s.startsWith('<<<', i)) {
      i += 2
    } else if (s.startsWith('<<', i)) {
      HEREDOC_TAG.lastIndex = i + 2
      const match = HEREDOC_TAG.exec(s)
      if (match) {
        heredocs.push(match[1] ?? match[2] ?? match[3])
        i = HEREDOC_TAG.lastIndex - 1
      }
    } else if (c === '\n') {
      for (const tag of heredocs.splice(0)) i = skipHeredoc(s, i, tag)
    }
  }
  return s.length
}

const BRACKET = /\[[^\s\]]{1,256}\]/y

function scan(s: string, depth: number): ScanItem[] {
  checkNesting(depth)
  const items: ScanItem[] = []
  const substitutions: ScanItem[] = []
  let seg: RawSegment = { words: [], redirects: [] }
  let word: Word | null = null
  let quote = ''
  let redirect = false
  let heredocNext = false
  const heredocs: string[] = []

  const add = (text: string, glob = text): void => {
    word ??= { text: '', glob: '' }
    word.text += text
    word.glob += glob
  }
  const flush = (): void => {
    if (!word) return
    if (heredocNext) heredocs.push(word.text)
    else (redirect ? seg.redirects : seg.words).push(word)
    heredocNext = redirect = false
    word = null
  }
  const end = (): void => {
    flush()
    redirect = false
    for (const item of substitutions.splice(0)) items.push(item)
    if (seg.words.length || seg.redirects.length) items.push(seg)
    seg = { words: [], redirects: [] }
  }
  /** Queues a nested command to run before this segment, and stands in for its output. */
  const substitute = (body: string): void => {
    substitutions.push('(')
    for (const item of scan(body, depth + 1)) substitutions.push(item)
    substitutions.push(')')
    add('$()')
  }

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    const next = s[i + 1]
    if (quote === "'") {
      if (c === "'") quote = ''
      else add(c)
    } else if (c === '\\') {
      if (next === '\n') i++
      else if (next === '\r' && s[i + 2] === '\n') i += 2
      else if (!quote || (next && '$`"\\'.includes(next))) add(s[++i] ?? '')
      else add(c)
    } else if (c === '`') {
      const close = backtickEnd(s, i + 1)
      substitute(s.slice(i + 1, close).replace(/\\([`$\\])/g, '$1'))
      i = close
    } else if (c === '$' && next === '(') {
      const arithmetic = arithmeticEnd(s, i)
      if (arithmetic >= 0) {
        add(s.slice(i, arithmetic + 1))
        i = arithmetic
      } else {
        const close = substitutionEnd(s, i + 2, depth + 1)
        substitute(s.slice(i + 2, close))
        i = close
      }
    } else if (quote) {
      if (c === quote) quote = ''
      else add(c)
    } else if (c === '$' && next === "'") {
      const close = ansiQuoteEnd(s, i + 2)
      add(s.slice(i + 2, close).replace(/\\(.)/gs, '$1'))
      i = close
    } else if (c === '"' || c === "'") {
      quote = c
      add('')
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flush()
    } else if (c === '#' && !word) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++
    } else if (c === '\n') {
      end()
      for (const tag of heredocs.splice(0)) i = skipHeredoc(s, i, tag)
    } else if (c === ';' || c === '|') {
      end()
    } else if (c === '(' || c === ')') {
      end()
      items.push(c)
    } else if (c === '&' && next === '>') {
      flush()
      redirect = true
      i += s[i + 2] === '>' ? 2 : 1
    } else if (c === '&') {
      end()
    } else if (c === '>') {
      const fd = word as Word | null
      if (fd && /^\d+$/.test(fd.text)) word = null
      else flush()
      redirect = true
      if (next === '>' || next === '|') i++
      if (s[i + 1] === '&') {
        i++
        // `>&2` and `2>&-` duplicate a descriptor; `>&file` is a real target.
        if (/[\d-]/.test(s[i + 1] ?? '')) {
          while (/[\d-]/.test(s[i + 1] ?? '')) i++
          redirect = false
        }
      }
    } else if (c === '<') {
      flush()
      if (next === '<' && s[i + 2] === '<') {
        i += 2
      } else if (next === '<') {
        i += s[i + 2] === '-' ? 2 : 1
        heredocNext = true
      }
    } else if (c === '*') {
      add(c, ANY)
    } else if (c === '?') {
      add(c, ONE)
    } else {
      BRACKET.lastIndex = i
      const bracket = c === '[' ? BRACKET.exec(s)?.[0] : undefined
      if (bracket) {
        add(bracket, ONE)
        i += bracket.length - 1
      } else {
        add(c)
      }
    }
  }
  end()
  return items
}

/** Expands a leading `~` and resolves against cwd. */
export function expandPath(path: string, cwd: string): string {
  return resolve(cwd, path.replace(/^~(?=$|[/\\])/, homedir()))
}

const SHELL_VAR = /^\$(?:(HOME|PWD)|\{(HOME|PWD)\})(?=$|[/\\])/

function refOf(path: string, cwd: string): string {
  return expandPath(path.replace(SHELL_VAR, (_m, a, b) => ((a ?? b) === 'HOME' ? homedir() : cwd)), cwd)
}

/** Whether a path from this module, which can hold wildcards, could be `path`. */
export function couldMatch(ref: string, path: string): boolean {
  if (ref === path) return true
  if (!ref.includes(ANY) && !ref.includes(ONE)) return false
  const source = ref
    .replace(new RegExp(`${ANY}+`, 'g'), ANY)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll(ANY, '[^/\\\\]*')
    .replaceAll(ONE, '[^/\\\\]')
  return new RegExp(`^${source}$`).test(path)
}

const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/
const WRAPPER_VALUE_OPTIONS: Record<string, string[]> = {
  xargs: ['-n', '-I', '-L', '-P', '-s'],
  sudo: ['-u', '-g'],
  env: ['-u', '-C'],
  timeout: ['-k', '-s'],
  nice: ['-n']
}
const PREFIXES = new Set([
  'sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'time', 'timeout', 'xargs',
  'if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{'
])

/** The command word and its arguments, past assignments, wrappers and keywords. */
function commandOf(words: Word[]): { name: string; args: Word[] } {
  let i = 0
  while (i < words.length) {
    const text = words[i].text
    if (ASSIGNMENT.test(text)) {
      i++
    } else if (text === 'function') {
      i += 2
    } else if (PREFIXES.has(text)) {
      i++
      while (words[i]?.text.startsWith('-')) i += WRAPPER_VALUE_OPTIONS[text]?.includes(words[i].text) ? 2 : 1
      if (text === 'timeout') i++
    } else {
      break
    }
  }
  return { name: (words[i]?.text ?? '').split(/[\\/]/).pop() ?? '', args: words.slice(i + 1) }
}

/** The script a shell or `eval` would run from this argument list. */
function innerScript(name: string, args: Word[]): string | null {
  if (name === 'eval') return args.map((a) => a.text).join(' ')
  if (!/^(ba|z|da|k)?sh$/.test(name)) return null
  const flag = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text))
  return flag < 0 ? null : (args[flag + 1]?.text ?? null)
}

export function parseShell(command: string, cwd: string, depth = 0): Segment[] {
  const out: Segment[] = []
  const subshells: string[] = []
  for (const item of scan(command, depth)) {
    if (item === '(') {
      subshells.push(cwd)
    } else if (item === ')') {
      cwd = subshells.pop() ?? cwd
    } else {
      out.push({ ...item, cwd })
      const { name, args } = commandOf(item.words)
      const script = innerScript(name, args)
      if (script !== null) out.push(...parseShell(script, cwd, depth + 1))
      if (name === 'cd') cwd = refOf(positional(args)[0]?.text ?? '~', cwd)
    }
  }
  return out
}

/** Arguments that aren't flags; everything after `--` counts. */
function positional(args: Word[]): Word[] {
  const stop = args.findIndex((a) => a.text === '--')
  return stop < 0
    ? args.filter((a) => !a.text.startsWith('-'))
    : [...args.slice(0, stop).filter((a) => !a.text.startsWith('-')), ...args.slice(stop + 1)]
}

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])

/** The git subcommand and arguments past its global options. `-C` moves the directory. */
function gitCall(args: Word[], cwd: string): { sub: string; args: Word[]; cwd: string } {
  let i = 0
  while (args[i]?.text.startsWith('-')) {
    if (args[i].text === '-C' && args[i + 1]) cwd = refOf(args[i + 1].text, cwd)
    i += GIT_VALUE_OPTIONS.has(args[i].text) ? 2 : 1
  }
  return { sub: args[i]?.text ?? '', args: args.slice(i + 1), cwd }
}

const hasFlag = (args: Word[], long: string, short: string): boolean =>
  args.some((a) => a.text === long || (/^-[a-zA-Z]+$/.test(a.text) && a.text.includes(short)))

function isForcePush(args: Word[]): boolean {
  return args.some((a) => /^--force(-with-lease|-if-includes)?(=|$)/.test(a.text) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a.text) || /^\+./.test(a.text))
}

function gitAskKeys(sub: string, args: Word[]): string[] {
  if (sub === 'push') return ['git push']
  if (sub === 'merge') return ['git merge']
  if (sub === 'worktree' && args[0]?.text === 'remove') return ['git worktree remove']
  const forcedDelete = hasFlag(args, '--delete', 'd') && hasFlag(args, '--force', 'f')
  if (sub === 'branch' && (hasFlag(args, '-D', 'D') || forcedDelete)) return ['git branch -D']
  return []
}

const GH_VALUE_OPTIONS = new Set([
  '-R', '--repo', '-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field', '--input',
  '-q', '--jq', '-t', '--template', '-p', '--preview', '--hostname', '--cache'
])

/** A write method, stated or implied by a body, on a repository's pulls. */
function isGhApiPullsWrite(args: Word[], endpoint: string | undefined): boolean {
  if (!endpoint || !/^\/?repos\/[^/]+\/[^/]+\/pulls(?:[/?]|$)/.test(endpoint)) return false
  let method = ''
  args.forEach((a, i) => {
    const match = /^(?:-X|--method=?)(.*)$/.exec(a.text)
    if (match) method = match[1] || (args[i + 1]?.text ?? '')
  })
  if (method) return !/^(GET|HEAD)$/i.test(method)
  return args.some((a) => /^(-[fF]|--raw-field|--field|--input)/.test(a.text))
}

function ghAskKeys(args: Word[]): string[] {
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (GH_VALUE_OPTIONS.has(args[i].text)) i++
    else if (!args[i].text.startsWith('-')) words.push(args[i].text)
  }
  if (words[0] === 'pr' && words[1] === 'create') return ['gh pr create']
  if (words[0] === 'pr' && words[1] === 'merge') return ['gh pr merge']
  return words[0] === 'api' && isGhApiPullsWrite(args, words[1]) ? ['gh pr merge'] : []
}

const WRITE_VERBS = new Set(['rm', 'unlink', 'rmdir', 'mkdir', 'touch', 'truncate', 'chmod', 'chown', 'tee'])
const COPY_VERBS = new Set(['cp', 'rsync', 'install', 'ln'])
const DELETING_EXEC = new Set(['rm', 'unlink', 'rmdir', 'mv', 'shred'])
const OUTPUT_OPTIONS: Record<string, string[]> = {
  curl: ['-o', '--output'],
  wget: ['-O', '--output-document'],
  sort: ['-o', '--output']
}
const GIT_WRITES = new Set(['checkout', 'restore', 'rm', 'mv'])

/** Values of an option, written as `-o v`, `-ov`, `--opt v` or `--opt=v`. */
function optionValues(args: Word[], names: string[]): Word[] {
  return args.flatMap((a, i) => {
    if (names.includes(a.text)) return args[i + 1] ? [args[i + 1]] : []
    const prefix = names.map((n) => (n.startsWith('--') ? `${n}=` : n)).find((p) => a.text.startsWith(p))
    return prefix ? [{ text: a.text.slice(prefix.length), glob: a.glob.slice(prefix.length) }] : []
  })
}

/** What a copy-like command reads and where it writes. `rsync -t` means times, not a target. */
function copyParts(name: string, args: Word[]): { sources: Word[]; target: Word | undefined } {
  const paths = positional(args)
  const named = name === 'rsync' ? undefined : optionValues(args, ['-t', '--target-directory'])[0]
  const target = named ?? paths.at(-1)
  return { target, sources: paths.filter((p) => p.text !== target?.text) }
}

/** A copy writes its target, and into it when that's a directory. */
function copyTargets(name: string, args: Word[]): Word[] {
  const { sources, target } = copyParts(name, args)
  if (!target) return []
  const within = sources.map((source) => ({
    text: `${target.text}/${basename(source.text)}`,
    glob: `${target.glob}/${basename(source.glob)}`
  }))
  return [target, ...within]
}

const isTarExtract = (args: Word[]): boolean =>
  /^[a-zA-Z]*x/.test(args[0]?.text ?? '') || hasFlag(args, '--extract', 'x')

function writtenWords(name: string, args: Word[]): Word[] {
  if (WRITE_VERBS.has(name)) return positional(args)
  if (name === 'mv') return [...positional(args), ...copyTargets(name, args)]
  if (COPY_VERBS.has(name)) return copyTargets(name, args)
  if (OUTPUT_OPTIONS[name]) return optionValues(args, OUTPUT_OPTIONS[name])
  if (name === 'tar') return isTarExtract(args) ? optionValues(args, ['-C', '--directory']) : []
  if (name === 'dd') {
    return args.filter((a) => a.text.startsWith('of=')).map((a) => ({ text: a.text.slice(3), glob: a.glob.slice(3) }))
  }
  if (name === 'sed' || name === 'gsed') {
    return args.some((a) => /^-[a-zA-Z]*i/.test(a.text) || a.text.startsWith('--in-place')) ? positional(args) : []
  }
  if (name === 'perl') return args.some((a) => /^-[0-9a-zA-Z]{0,4}i/.test(a.text) && !/^-[MmI]/.test(a.text)) ? positional(args) : []
  return []
}

/** Arguments the command takes away or changes throughout. A move's destination survives. */
function destroyedWords(name: string, args: Word[]): Word[] {
  const paths = positional(args).filter((a) => a.text)
  if (name === 'rm' || name === 'rmdir' || name === 'unlink') return paths
  if (name === 'mv') return copyParts(name, args).sources.filter((a) => a.text)
  return (name === 'chmod' || name === 'chown') && hasFlag(args, '--recursive', 'R') ? paths : []
}

function isFindDelete(args: Word[]): boolean {
  return args.some((a, i) =>
    a.text === '-delete' ||
    (/^-(exec|execdir|ok|okdir)$/.test(a.text) && DELETING_EXEC.has((args[i + 1]?.text ?? '').split(/[\\/]/).pop() ?? ''))
  )
}

function findRoots(args: Word[], cwd: string): string[] {
  const first = args.findIndex((a) => /^[-(!]/.test(a.text))
  const roots = (first < 0 ? args : args.slice(0, first)).map((a) => refOf(a.glob, cwd))
  return roots.length ? roots : [cwd]
}

export function analyzeShell(command: string, cwd: string): ShellAnalysis {
  if (command.length > MAX_COMMAND_LENGTH) throw new Error('Shell command is too long to analyse.')
  const segments = parseShell(command, cwd)
  if (segments.length > MAX_SEGMENTS) throw new Error('Shell command has too many parts to analyse.')
  const result: ShellAnalysis = { forcePush: false, ask: [], writes: [], destroys: [], paths: [] }
  for (const seg of segments) {
    const { name, args } = commandOf(seg.words)
    const refs = (words: Word[], from = seg.cwd): string[] => words.map((w) => refOf(w.glob, from))
    result.writes.push(...refs(seg.redirects), ...refs(writtenWords(name, args)))
    result.destroys.push(...refs(destroyedWords(name, args)))
    for (const word of [...seg.words, ...seg.redirects]) {
      if (!word.text) continue
      result.paths.push(refOf(word.glob, seg.cwd))
      const value = word.glob.replace(/^[^=]*=|^@/, '')
      if (value && value !== word.glob) result.paths.push(refOf(value, seg.cwd))
    }
    if (name === 'git') {
      const git = gitCall(args, seg.cwd)
      if (git.sub === 'push' && isForcePush(git.args)) result.forcePush = true
      if (GIT_WRITES.has(git.sub)) result.writes.push(...refs(positional(git.args), git.cwd))
      result.ask.push(...gitAskKeys(git.sub, git.args))
    } else if (name === 'gh') {
      result.ask.push(...ghAskKeys(args))
    } else if (name === 'find' && isFindDelete(args)) {
      const roots = findRoots(args, seg.cwd)
      result.writes.push(...roots)
      result.destroys.push(...roots)
    }
  }
  result.ask = [...new Set(result.ask)]
  return result
}
