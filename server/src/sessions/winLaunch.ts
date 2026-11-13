// Pure: how a session's agent is started on Windows, where there is no login shell to hand a
// command line to. The head (the user's command, or the provider's binary) is found on PATH
// with PATHEXT, and then:
//   - an .exe or .com is spawned directly, its arguments quoted by the MSVC rules every C/C++
//     and Node program parses with (CommandLineToArgvW), so newlines and quotes survive;
//   - an npm shim (.cmd written by cmd-shim) is unwrapped: Trek runs node with the shim's
//     script directly, so no cmd.exe sits in between (multi-line prompts work, and Ctrl+C never
//     asks "Terminate batch job (Y/N)?");
//   - any other .cmd or .bat runs under cmd.exe with its metacharacters escaped (cross-spawn's
//     rules); cmd.exe can't pass a newline inside an argument, so such a launch is refused.
// Everything here takes the env and the file system as arguments, so it is tested on any OS.
import { win32 } from 'node:path'
import type { LaunchSpec } from '../../../src/shared/providers/types'
import { argvOf } from '../../../src/shared/providers/shell.ts'

/** What node-pty spawns: `file`, with `args` as the raw command line after it. */
export interface WinSpawnPlan {
  file: string
  /** The command line after the program (node-pty prepends the quoted file) */
  args: string
}

export interface WinLaunchDeps {
  env: Record<string, string | undefined>
  /** The session's working directory, for a relative head (`.\tools\claude.exe`) */
  cwd: string
  isFile: (path: string) => boolean
  readFile: (path: string) => string
}

/** Windows' limit on a whole command line (CreateProcess's lpCommandLine), in UTF-16 units. */
export const MAX_COMMAND_LINE = 32_767

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** A variable of the env, by Windows' case-insensitive name (`Path`, `PATH`). */
export function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted && value !== undefined) return value
  return undefined
}

/** One argument quoted for CommandLineToArgvW and the MSVC runtime. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[ \t\n\v"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const c of arg) {
    if (c === '\\') {
      slashes++
      continue
    }
    // Backslashes are literal unless a quote follows: then each is doubled, and the quote escaped.
    out += c === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + c
    slashes = 0
  }
  // Before the closing quote, backslashes are doubled so they don't escape it.
  return `${out}${'\\'.repeat(slashes * 2)}"`
}

/**
 * Splits a command line the way CommandLineToArgvW (and the MSVC runtime since 2008) does. The
 * first word is the program: quotes group, backslashes are literal. Used for the user's head
 * text, and by the tests as the round trip of quoteWindowsArg.
 */
export function parseWindowsCommandLine(line: string): string[] {
  const out: string[] = []
  let i = 0
  const n = line.length
  const blank = (c: string | undefined): boolean => c === ' ' || c === '\t'
  // The program name.
  while (blank(line[i])) i++
  if (i >= n) return out
  let program = ''
  let quoted = false
  for (; i < n; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (blank(c) && !quoted) break
    else program += c
  }
  out.push(program)
  for (;;) {
    while (blank(line[i])) i++
    if (i >= n) return out
    let arg = ''
    let inQuotes = false
    for (; i < n; ) {
      const c = line[i]
      if (c === '\\') {
        let slashes = 0
        while (line[i] === '\\') {
          slashes++
          i++
        }
        if (line[i] === '"') {
          arg += '\\'.repeat(Math.floor(slashes / 2))
          if (slashes % 2 === 1) {
            arg += '"'
            i++
          }
        } else arg += '\\'.repeat(slashes)
        continue
      }
      if (c === '"') {
        // Inside quotes, "" is a literal quote (and the quotes go on).
        if (inQuotes && line[i + 1] === '"') {
          arg += '"'
          i += 2
          continue
        }
        inQuotes = !inQuotes
        i++
        continue
      }
      if (blank(c) && !inQuotes) break
      arg += c
      i++
    }
    out.push(arg)
  }
}

/**
 * The executable `name` runs, as CreateProcess would find it, without the current directory
 * (a repository could plant a `claude.cmd`): a path (absolute, or relative to `cwd`) as given,
 * else each PATH directory in turn; each with PATHEXT's extensions unless it already has one.
 */
export function resolveWindowsCommand(name: string, deps: Pick<WinLaunchDeps, 'env' | 'cwd' | 'isFile'>): string | undefined {
  const exts = (envValue(deps.env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.'))
  const hasExt = exts.includes(win32.extname(name).toLowerCase())
  const candidates = (base: string): string[] => (hasExt ? [base] : exts.map((e) => base + e))
  const find = (base: string): string | undefined => candidates(base).find((c) => deps.isFile(c))
  if (/[\\/]/.test(name) || win32.isAbsolute(name)) return find(win32.resolve(deps.cwd, name))
  for (const raw of (envValue(deps.env, 'PATH') ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!dir || !win32.isAbsolute(dir)) continue
    const hit = find(win32.join(dir, name))
    if (hit) return hit
  }
  return undefined
}

/** An npm shim's target: node (the shim's own node.exe if it has one), its arguments, and the script. */
export interface CmdShim {
  /** The shim directory's node.exe, if there is one */
  bundledNode?: string
  /** Arguments to node before the script (`--no-warnings=DEP0040`) */
  nodeArgs: string[]
  script: string
}

/**
 * Reads a shim npm (cmd-shim) wrote for a node script; undefined for anything else (another
 * interpreter, or a batch file of the user's own).
 */
export function parseCmdShim(text: string, shimPath: string, isFile: (path: string) => boolean): CmdShim | undefined {
  if (!/^@ECHO off/im.test(text)) return undefined
  // The interpreter when the shim's directory has no node.exe: only node is unwrapped.
  const fallback = /\)\s*ELSE\s*\(\s*SET\s+"_prog=([^"]*)"/i.exec(text)?.[1]
  if (fallback !== 'node') return undefined
  const run = /"%_prog%"[ \t]*(.*?)[ \t]*"%dp0%\\([^"]+)"[ \t]+%\*[ \t]*$/im.exec(text)
  if (!run) return undefined
  const dir = win32.dirname(shimPath)
  const nodeArgs = run[1].trim() === '' ? [] : parseWindowsCommandLine(`node ${run[1]}`).slice(1)
  const own = win32.join(dir, 'node.exe')
  return { ...(isFile(own) ? { bundledNode: own } : {}), nodeArgs, script: win32.resolve(dir, run[2]) }
}

// cmd.exe's metacharacters (cross-spawn's set).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** `arg` for a batch file run by cmd.exe: MSVC quoting, then each metacharacter ^-escaped (twice when the batch passes %* on). */
export function cmdEscapeArg(arg: string, doubleEscape: boolean): string {
  let out = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  out = out.replace(CMD_META, '^$1')
  return doubleEscape ? out.replace(CMD_META, '^$1') : out
}

/** The batch file's own path for cmd.exe: its metacharacters ^-escaped. */
export function cmdEscapeCommand(path: string): string {
  return path.replace(CMD_META, '^$1')
}

function joinArgs(args: string[]): string {
  return args.map(quoteWindowsArg).join(' ')
}

/** The program and command line that start `spec` on Windows. Throws with a message for the session. */
export function winSpawnPlan(spec: LaunchSpec, deps: WinLaunchDeps): WinSpawnPlan {
  const headWords = parseWindowsCommandLine(spec.head)
  const name = headWords[0]
  if (!name) throw new Error('No command to run')
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) {
    throw new Error(`Env prefixes (${name.split('=')[0]}=…) aren't supported on Windows; set the variable in the server's environment instead`)
  }
  const argv = [...headWords.slice(1), ...argvOf(spec.args)]
  const resolved = resolveWindowsCommand(name, deps)
  if (!resolved) throw new Error(`\`${name}\` not found on PATH`)
  const ext = win32.extname(resolved).toLowerCase()
  let plan: WinSpawnPlan
  if (ext === '.cmd' || ext === '.bat') {
    const text = deps.readFile(resolved)
    const shim = parseCmdShim(text, resolved, deps.isFile)
    const node = shim ? (shim.bundledNode ?? resolveWindowsCommand('node.exe', deps)) : undefined
    if (shim && node) {
      plan = { file: node, args: joinArgs([...shim.nodeArgs, shim.script, ...argv]) }
    } else {
      if (argv.some((a) => /[\r\n]/.test(a))) {
        throw new Error(
          `\`${name}\` is a batch file (${win32.basename(resolved)}), which can't receive multi-line arguments; install the agent's native binary or its npm package`
        )
      }
      const comspec = envValue(deps.env, 'ComSpec') || 'C:\\Windows\\System32\\cmd.exe'
      // A batch file that passes %* on (a shim) re-parses its arguments: escape them twice.
      const doubleEscape = /%\*/.test(text)
      const inner = [cmdEscapeCommand(resolved), ...argv.map((a) => cmdEscapeArg(a, doubleEscape))].join(' ')
      plan = { file: comspec, args: `/d /s /c "${inner}"` }
    }
  } else plan = { file: resolved, args: joinArgs(argv) }
  const length = quoteWindowsArg(plan.file).length + 1 + plan.args.length
  if (length > MAX_COMMAND_LINE) {
    throw new Error(`The command line is ${length} characters, over Windows' limit of ${MAX_COMMAND_LINE}; shorten the session's prompt`)
  }
  return plan
}
