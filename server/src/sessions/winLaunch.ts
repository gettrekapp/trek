// Pure: how a session's agent is started on Windows, where there is no login shell to hand a
// command line to. The head (the user's command, or the provider's binary) is found on PATH
// with PATHEXT, and then:
//   - an .exe or .com is spawned directly, its arguments quoted by the MSVC rules every C/C++
//     and Node program parses with (CommandLineToArgvW), so newlines and quotes survive;
//   - an npm shim (.cmd written by cmd-shim) is unwrapped: Trek runs node with the shim's
//     script directly, so no cmd.exe sits in between (multi-line prompts work, and Ctrl+C never
//     asks "Terminate batch job (Y/N)?"); one for a native .exe bin runs that .exe directly;
//   - any other .cmd or .bat runs under cmd.exe with its metacharacters escaped (cross-spawn's
//     rules); cmd.exe can't pass a newline inside an argument, nor read a line over 8191
//     characters, so such a launch is refused;
//   - anything else PATHEXT names (.js, .vbs, .wsf, .msc…) is refused: CreateProcess can't run it.
// Everything here takes the env and the file system as arguments, so it is tested on any OS.
import { win32 } from 'node:path'
import type { LaunchSpec } from '../../../src/shared/providers/types'
import { argvOf } from '../../../src/shared/providers/shell.ts'
import { envValue, findOnPath, pathExts } from '../../../src/host/commandPath.ts'

export { envValue }

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

/** Windows' limit on a whole command line (CreateProcess's lpCommandLine), in UTF-16 units, its NUL included. */
export const MAX_COMMAND_LINE = 32_767

/** cmd.exe's limit on the command line it reads, in characters. */
export const MAX_CMD_LINE = 8_191

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
  const exts = pathExts(deps.env)
  if (/[\\/]/.test(name) || win32.isAbsolute(name)) {
    const base = win32.resolve(deps.cwd, name)
    const hasExt = exts.includes(win32.extname(name).toLowerCase())
    return (hasExt ? [base] : exts.map((e) => base + e)).find((c) => deps.isFile(c))
  }
  return findOnPath(name, deps.env, deps.isFile, exts)
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

// The lines of cmd-shim's head (lower-cased), before the one that runs the target.
const CMD_SHIM_HEAD = new Set(['@echo off', 'goto start', ':find_dp0', 'set dp0=%~dp0', 'exit /b', ':start', 'setlocal', 'call :find_dp0'])

/**
 * The .exe (or .com) a shim that only runs it with `%*` points at: what cmd-shim writes for a
 * package whose bin is a native program (`"%dp0%\…\x.exe"   %*`, no _prog block), or the same
 * by hand with `%~dp0`. Undefined for anything else: a line besides cmd-shim's head (the batch
 * file does more than run the program, which skipping cmd.exe would skip too), arguments of the
 * shim's own, `%dp0%` that nothing sets, or a program that isn't there.
 */
export function parseExeShim(text: string, shimPath: string, isFile: (path: string) => boolean): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  const last = lines.pop()
  if (last === undefined || !lines.every((l) => CMD_SHIM_HEAD.has(l.toLowerCase().replace(/\s+/g, ' ')))) return undefined
  const run = /^@?"(%dp0%|%~dp0)\\?([^"%]+\.(?:exe|com))"[ \t]+%\*$/i.exec(last)
  if (!run) return undefined
  if (run[1].toLowerCase() === '%dp0%' && !lines.some((l) => l.toLowerCase() === 'set dp0=%~dp0')) return undefined
  const exe = win32.resolve(win32.dirname(shimPath), run[2])
  return isFile(exe) ? exe : undefined
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

/** The whole command line `plan` makes (node-pty puts the quoted file before its args). */
function commandLineLength(plan: WinSpawnPlan): number {
  return quoteWindowsArg(plan.file).length + 1 + plan.args.length
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
    const exe = shim ? undefined : parseExeShim(text, resolved, deps.isFile)
    if (exe) {
      plan = { file: exe, args: joinArgs(argv) }
    } else if (shim && node) {
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
      const cmdLength = commandLineLength(plan)
      if (cmdLength > MAX_CMD_LINE) {
        throw new Error(
          `\`${name}\` is a batch file (${win32.basename(resolved)}), and its cmd.exe command line is ${cmdLength} characters, over cmd's limit of ${MAX_CMD_LINE}; shorten the session's prompt, or install the agent's native binary or its npm package`
        )
      }
    }
  } else if (ext === '.exe' || ext === '.com') plan = { file: resolved, args: joinArgs(argv) }
  else {
    throw new Error(
      `\`${name}\` resolves to ${win32.basename(resolved)}, a ${ext || 'extensionless'} file: Trek runs only .exe, .com, .cmd or .bat programs on Windows`
    )
  }
  const length = commandLineLength(plan)
  // The limit counts the terminating NUL.
  if (length >= MAX_COMMAND_LINE) {
    throw new Error(`The command line is ${length} characters, over Windows' limit of ${MAX_COMMAND_LINE}; shorten the session's prompt`)
  }
  return plan
}
