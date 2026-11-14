import type { LaunchArg, LaunchSpec } from './types'

/** Single-quote a value for a POSIX shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Trim each part, drop the empty ones, join with spaces. */
export function joinCommand(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
}

/** Text Trek controls (a flag, a known mode, a session id): never quoted. */
export const word = (value: string): LaunchArg => ({ kind: 'word', value })
/** A value from the user or a setting; `prefix` (`--model=`) stays outside the POSIX quotes. */
export const quoted = (value: string, prefix?: string): LaunchArg => (prefix ? { kind: 'quoted', value, prefix } : { kind: 'quoted', value })
/** Arguments the user typed as text (Claude's `claudeArgs`): the POSIX line takes them as typed. */
export const raw = (text: string): LaunchArg => ({ kind: 'raw', text })

/** An argument as the POSIX command line has it. */
export function posixArg(arg: LaunchArg): string {
  if (arg.kind === 'word') return arg.value
  if (arg.kind === 'raw') return arg.text
  return `${arg.prefix ?? ''}${shellQuote(arg.value)}`
}

/**
 * The arguments as the agent receives them, without a shell: what Windows spawns. Raw text is
 * split by splitArgs. Throws on raw text splitArgs refuses.
 */
export function argvOf(args: readonly LaunchArg[]): string[] {
  return args.flatMap((arg) => (arg.kind === 'raw' ? splitArgs(arg.text) : [arg.kind === 'quoted' ? `${arg.prefix ?? ''}${arg.value}` : arg.value]))
}

/**
 * The spec for `head` (the user's command, or the provider's binary) and `args`. `command` is the
 * POSIX line (run with `$SHELL -ilc`), exactly as Trek built it before Windows: head first, as
 * typed, then each argument, joined by joinCommand.
 */
export function launchSpec(head: string, args: LaunchArg[], env?: Record<string, string>): LaunchSpec {
  const command = joinCommand([head, ...args.map(posixArg)])
  return env ? { command, head, args, env } : { command, head, args }
}

/**
 * Words of text the user typed as arguments, for a launch without a shell (Windows). Spaces and
 * tabs separate words; '…' and "…" group (and are removed); inside "…", \" is a quote. Any other
 * backslash is kept as is, so `C:\work\dir` survives. Throws on an unclosed quote.
 */
export function splitArgs(text: string): string[] {
  const words: string[] = []
  let current = ''
  let inWord = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (inWord) words.push(current)
      current = ''
      inWord = false
      continue
    }
    inWord = true
    if (c === "'" || c === '"') {
      const close = c
      let j = i + 1
      for (; j < text.length && text[j] !== close; j++) {
        if (close === '"' && text[j] === '\\' && text[j + 1] === '"') {
          current += '"'
          j++
        } else current += text[j]
      }
      if (j >= text.length) throw new Error(`Unclosed ${close} in the arguments: ${text}`)
      i = j
      continue
    }
    current += c
  }
  if (inWord) words.push(current)
  return words
}
