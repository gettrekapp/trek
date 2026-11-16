// A process's command line, and whether it is a Local server's: shared by the app's supervisor
// (src/main/localServer.ts) and trek-server's `stop --local` (server/src/localStop.ts), so neither
// ever ends a pid that a stale local.json or local.lock names but some other program now holds.
// Pure: the callers run the command.

/**
 * How to read a pid's command line: `ps` on macOS and Linux; PowerShell's Win32_Process on Windows
 * (there is no ps), from System32 (`systemRoot`, %SystemRoot%), never PATH or the cwd.
 */
export function processCommandLine(
  pid: number,
  platform: string = process.platform,
  systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows'
): { file: string; args: string[] } {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${pid}`)
  if (platform !== 'win32') return { file: 'ps', args: ['-o', 'command=', '-p', String(pid)] }
  return {
    file: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]
  }
}

/**
 * The command line (processCommandLine's: `ps -o command=`, or Win32_Process's CommandLine) is a
 * local server of `profile`: it mentions trek-server (the bundle's trek-server.cjs, or an installed
 * trek-server bin), has `start --local`, and has `--local-profile <profile>` for a named profile or
 * no `--local-profile` for the default one. Read with its `"` removed: Windows quotes the
 * executable, and any argument with a space (a user folder, `Trek Dev`). Errs towards "a server":
 * that only ever refuses a Reset or a SIGKILL.
 */
export function isLocalServerCommand(command: string, profile: string | undefined): boolean {
  const line = command.replaceAll('"', '')
  if (!line.includes('trek-server') || !/(^|\s)start\s+--local(\s|$)/.test(line)) return false
  const named = /(^|\s)--local-profile\s+(\S+)/.exec(line)?.[2]
  return named === profile
}
