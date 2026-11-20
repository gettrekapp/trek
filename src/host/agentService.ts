// Whether a program resolves in the user's login shell (server.agents' installed check on POSIX).
// Electron-free: shared by the Electron main process and the server. Codex's session discovery,
// here before plugins A1, is the codex plugin's (plugins/codex/server/discovery.ts).
import { execFile } from 'node:child_process'
import { shellQuote } from '../shared/providers/shell.ts'
import { hidden } from './childOptions.ts'
import { commandPath } from './commandPath.ts'

/** Whether `command` resolves in the user's login shell. */
export function commandExists(command: string): Promise<boolean> {
  const shell = process.env.SHELL || '/bin/sh'
  return new Promise((resolve) => {
    try {
      execFile(commandPath(shell), ['-lc', `command -v ${shellQuote(command)}`], hidden({ timeout: 10_000 }), (err) =>
        resolve(!err)
      )
    } catch {
      resolve(false) // Windows: the shell is not on PATH
    }
  })
}
