// A process's command line, and whether it is a Local server's: shared by the app's supervisor
// (src/main/localServer.ts) and trek-server's `stop --local` (server/src/localStop.ts), so neither
// ever ends a pid that a stale local.json or local.lock names but some other program now holds.
// Pure: the callers run the command.

/**
 * How to read a pid's command line: `ps -ww` on macOS and Linux; PowerShell's Win32_Process on Windows
 * (there is no ps), from System32 (`systemRoot`: %SystemRoot%, or %windir%, as commandPath finds
 * Windows' own tools), never PATH or the cwd.
 */
export function processCommandLine(
  pid: number,
  platform: string = process.platform,
  systemRoot: string = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
): { file: string; args: string[] } {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${pid}`)
  // -ww: never cut to the terminal's width (procps honours an exported COLUMNS without it).
  if (platform !== 'win32') return { file: 'ps', args: ['-ww', '-o', 'command=', '-p', String(pid)] }
  return {
    file: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    // UTF-8 out, so a path with non-ASCII letters decodes as Node reads it.
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`
    ]
  }
}

/**
 * A Windows command line split as CommandLineToArgvW (and the C runtime) splits it: the program
 * name runs to the next space, or within quotes to the closing quote, with no escapes; after it,
 * spaces and tabs separate arguments outside quotes, `"` toggles quoting, 2n backslashes before a
 * `"` are n backslashes (and the quote still toggles), 2n+1 are n and a literal `"`, and other
 * backslashes are literal. Inside quotes, `""` is a literal `"`.
 */
export function windowsArgv(line: string): string[] {
  const argv: string[] = []
  let i = 0
  const n = line.length
  const space = (c: string | undefined): boolean => c === ' ' || c === '\t'
  while (i < n && space(line[i])) i++
  if (i >= n) return argv
  // The program name.
  let program = ''
  if (line[i] === '"') {
    i++
    while (i < n && line[i] !== '"') program += line[i++]
    if (i < n) i++
  } else {
    while (i < n && !space(line[i])) program += line[i++]
  }
  argv.push(program)
  for (;;) {
    while (i < n && space(line[i])) i++
    if (i >= n) return argv
    let arg = ''
    let quoted = false
    while (i < n && (quoted || !space(line[i]))) {
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
      } else if (c === '"') {
        if (quoted && line[i + 1] === '"') {
          arg += '"'
          i += 2
        } else {
          quoted = !quoted
          i++
        }
      } else {
        arg += c
        i++
      }
    }
    argv.push(arg)
  }
}

/**
 * processCommandLine's output as argv: windowsArgv on Windows; elsewhere `ps` has joined the
 * arguments with spaces, so it is split on whitespace (an argument with a space is two tokens).
 */
export function commandArgv(command: string, platform: string = process.platform): string[] {
  return platform === 'win32' ? windowsArgv(command) : command.trim().split(/\s+/).filter((t) => t !== '')
}

/** The CLI's bin, by an argument's last path part: trek-server.cjs, trek-server, or its alias trek-daemon (server/package.json). */
const BIN_RE = /^trek-(server|daemon)/

/**
 * The command line (processCommandLine's: `ps -o command=`, or Win32_Process's CommandLine) is a
 * local server of `profile`, judged on whole arguments (commandArgv), as loosely as the CLI parses
 * them: a bin argument (its last path part starting with trek-server or trek-daemon), then
 * somewhere after it `start` and `--local`, in any order and with other flags between, and
 * `--local-profile <profile>` for a named profile or no `--local-profile` for the default one.
 * Each is a whole argument, so `trek-server start --local` inside some other program's quoted
 * argument is not a server (on Windows; ps output cannot tell).
 *
 * Errs towards "a server": a true lets a restart, an install's stop and `stop --local` signal or
 * end the pid (only while the lock and local.json both name it, too), and makes Reset refuse; a
 * false lets Reset delete the lock, and an install treat the pid as not ours.
 */
export function isLocalServerCommand(command: string, profile: string | undefined, platform: string = process.platform): boolean {
  const argv = commandArgv(command, platform)
  const bin = argv.findIndex((a) => BIN_RE.test(a.split(/[\\/]/).pop() ?? ''))
  if (bin < 0) return false
  const rest = argv.slice(bin + 1)
  if (!rest.includes('start') || !rest.includes('--local')) return false
  const at = rest.indexOf('--local-profile')
  const named = at < 0 ? undefined : rest[at + 1]
  return named === profile
}
