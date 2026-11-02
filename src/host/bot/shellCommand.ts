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
  /** `find` deletions with name tests. */
  finds: Array<{ roots: string[]; names: string[] }>
  /** Every word as an absolute path, plus the value of `x=value` and `@value`. */
  paths: string[]
}

type RawSegment = Pick<Segment, 'words' | 'redirects'>

function scan(s: string): Array<RawSegment | '(' | ')'> {
  const items: Array<RawSegment | '(' | ')'> = []
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
    if (seg.words.length || seg.redirects.length) items.push(seg)
    seg = { words: [], redirects: [] }
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
    } else if (quote) {
      if (c === quote) quote = ''
      else add(c)
    } else if (c === '"' || c === "'") {
      quote = c
      add('')
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flush()
    } else if (c === '#' && !word) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++
    } else if (c === '\n') {
      end()
      for (const tag of heredocs.splice(0)) {
        for (let line = null; line !== tag && i < s.length; ) {
          const nl = s.indexOf('\n', i + 1)
          const stop = nl < 0 ? s.length : nl
          line = s.slice(i + 1, stop).trim()
          i = stop
        }
      }
    } else if (c === ';' || c === '|' || c === '`') {
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
      const bracket = c === '[' ? /^\[[^\s\]]+\]/.exec(s.slice(i))?.[0] : undefined
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
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll(ANY, '[^/\\\\]*')
    .replaceAll(ONE, '[^/\\\\]')
  return new RegExp(`^${source}$`).test(path)
}

const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/
const PREFIXES = new Set([
  'sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'timeout', 'xargs',
  'if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{'
])

/** The command word and its arguments, past assignments, wrappers and keywords. */
function commandOf(words: Word[]): { name: string; args: Word[] } {
  let i = 0
  while (i < words.length) {
    const text = words[i].text
    if (ASSIGNMENT.test(text)) {
      i++
    } else if (PREFIXES.has(text)) {
      i++
      while (words[i]?.text.startsWith('-')) i++
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

export function parseShell(command: string, cwd: string): Segment[] {
  const out: Segment[] = []
  const subshells: string[] = []
  for (const item of scan(command)) {
    if (item === '(') {
      subshells.push(cwd)
    } else if (item === ')') {
      cwd = subshells.pop() ?? cwd
    } else {
      out.push({ ...item, cwd })
      const { name, args } = commandOf(item.words)
      const script = innerScript(name, args)
      if (script !== null) out.push(...parseShell(script, cwd))
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

const WRITE_VERBS = new Set(['rm', 'unlink', 'rmdir', 'mkdir', 'touch', 'truncate', 'chmod', 'chown', 'ln', 'tee'])
const COPY_VERBS = new Set(['cp', 'rsync', 'install'])
const GIT_WRITES = new Set(['checkout', 'restore', 'rm', 'mv'])

/** A copy writes its last argument, and into it when that's a directory. */
function copyTargets(args: Word[]): Word[] {
  const paths = positional(args)
  const target = paths.at(-1)
  if (!target) return []
  const within = paths.slice(0, -1).map((source) => ({
    text: `${target.text}/${basename(source.text)}`,
    glob: `${target.glob}/${basename(source.glob)}`
  }))
  return [target, ...within]
}

function writtenWords(name: string, args: Word[]): Word[] {
  if (WRITE_VERBS.has(name)) return positional(args)
  if (name === 'mv') return [...positional(args), ...copyTargets(args)]
  if (COPY_VERBS.has(name)) return copyTargets(args)
  if (name === 'dd') {
    return args.filter((a) => a.text.startsWith('of=')).map((a) => ({ text: a.text.slice(3), glob: a.glob.slice(3) }))
  }
  if (name === 'sed' || name === 'gsed') {
    return args.some((a) => /^-[a-zA-Z]*i/.test(a.text) || a.text.startsWith('--in-place')) ? positional(args) : []
  }
  if (name === 'perl') return args.some((a) => /^-[0-9a-zA-Z]{0,4}i/.test(a.text) && !/^-[MmI]/.test(a.text)) ? positional(args) : []
  return []
}

function isFindDelete(args: Word[]): boolean {
  return args.some((a, i) => a.text === '-delete' || (/^-(exec|execdir|ok|okdir)$/.test(a.text) && WRITE_VERBS.has(args[i + 1]?.text ?? '')))
}

function findCall(args: Word[], cwd: string): ShellAnalysis['finds'][number] {
  const first = args.findIndex((a) => /^[-(!]/.test(a.text))
  const roots = (first < 0 ? args : args.slice(0, first)).map((a) => refOf(a.glob, cwd))
  const names = args.flatMap((a, i) =>
    /^-i?name$/.test(a.text) && args[i + 1] ? [args[i + 1].text.replaceAll('*', ANY).replaceAll('?', ONE)] : []
  )
  return { roots: roots.length ? roots : [cwd], names }
}

export function analyzeShell(command: string, cwd: string): ShellAnalysis {
  const result: ShellAnalysis = { forcePush: false, ask: [], writes: [], finds: [], paths: [] }
  for (const seg of parseShell(command, cwd)) {
    const { name, args } = commandOf(seg.words)
    const refs = (words: Word[], from = seg.cwd): string[] => words.map((w) => refOf(w.glob, from))
    result.writes.push(...refs(seg.redirects), ...refs(writtenWords(name, args)))
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
      const find = findCall(args, seg.cwd)
      result.writes.push(...find.roots)
      if (find.names.length) result.finds.push(find)
    }
  }
  result.ask = [...new Set(result.ask)]
  return result
}
