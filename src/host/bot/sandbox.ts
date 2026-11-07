// The OS sandbox around each bot turn: nothing in the turn's process tree (the CLI, its tools,
// hooks, MCP servers and every shell) can read or change Trek's userData. Pure.
import { dirname, isAbsolute, normalize, relative, sep } from 'node:path'

export interface Sandbox {
  /** Runs in place of the CLI: `command`, then `args`, then the CLI's own argv. */
  command: string
  args: string[]
}

export type SandboxPlan = { ok: true; sandbox: Sandbox } | { ok: false; reason: string }

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
export const BWRAP = 'bwrap'

/** Each directory above `dir`, nearest first, up to the root. */
export function ancestorsOf(dir: string): string[] {
  const found: string[] = []
  for (let at = dir, up = dirname(at); up !== at; at = up, up = dirname(at)) found.push(up)
  return found
}

/**
 * The Seatbelt profile, for `ancestors` (at least 1) ancestors of userData. Every path comes in as
 * a `-D` parameter, so none is ever quoted into the profile's text.
 */
export function macProfile(ancestors: number): string {
  const literals = Array.from({ length: ancestors }, (_, i) => `(literal (param "ANC${i}"))`).join(' ')
  return [
    '(version 1)',
    '(allow default)',
    "; Trek's userData: nothing in the bot's process tree may read or change it.",
    '(deny file-read* file-write* (subpath (param "USERDATA")))',
    '; Renaming an ancestor would move userData out from under the rule above.',
    `(deny file-write-unlink ${literals})`,
    '; LaunchServices would start an app (one the bot wrote) outside this sandbox.',
    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.(lsd|coreservices|launchservices)"))'
  ].join('\n')
}

const WINDOWS_REASON = "The project bot needs an OS sandbox, which Windows doesn't provide. The bot runs on macOS and Linux."

/**
 * How to sandbox a turn on `platform`. `userData` must be the real path (realpathSync): a profile
 * given another spelling of it protects nothing.
 */
export function sandboxFor(platform: NodeJS.Platform, userData: string): SandboxPlan {
  if (platform === 'win32') return { ok: false, reason: WINDOWS_REASON }
  if (platform !== 'darwin' && platform !== 'linux') {
    return { ok: false, reason: `The project bot has no OS sandbox for ${platform}. The bot runs on macOS and Linux.` }
  }
  if (!isAbsolute(userData) || normalize(userData) !== userData || userData.endsWith(sep)) {
    return { ok: false, reason: `Trek's data folder has no usable real path for the bot's sandbox: ${userData}` }
  }
  if (platform === 'linux') {
    // A tmpfs over userData hides it from the whole mount namespace. The new PID namespace hides
    // Trek's own processes (and their /proc/<pid>/root); when its first process exits, the kernel
    // kills the rest. No --new-session, so Trek's process-group kill still reaches every process.
    return {
      ok: true,
      sandbox: {
        command: BWRAP,
        args: ['--dev-bind', '/', '/', '--tmpfs', userData, '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--']
      }
    }
  }
  const ancestors = ancestorsOf(userData)
  return {
    ok: true,
    sandbox: {
      command: SANDBOX_EXEC,
      args: [
        '-D', `USERDATA=${userData}`,
        ...ancestors.flatMap((dir, i) => ['-D', `ANC${i}=${dir}`]),
        '-p', macProfile(ancestors.length)
      ]
    }
  }
}

/**
 * The first of `paths` that is userData or inside it, if any: such a folder would be unreadable
 * to the bot, and putting it there is a mistake. All paths are real paths.
 */
export function insideUserData(platform: NodeJS.Platform, userData: string, paths: string[]): string | null {
  const fold = (path: string): string => (platform === 'darwin' || platform === 'win32' ? path.toLowerCase() : path)
  const root = fold(userData)
  return (
    paths.find((path) => {
      const rel = relative(root, fold(path))
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    }) ?? null
  )
}
