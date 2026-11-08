// The local server's files (spec, "Local server supervisor (phase 4)").
// `trek-server start --local` writes them; the app's supervisor (phase 4b)
// reads them. Paths are given as segments under the home directory, and each
// side joins them, so this file imports nothing.

/** The local profile's directory, under the home directory: ~/.config/trek-server/local */
export const LOCAL_PROFILE_DIR = ['.config', 'trek-server', 'local'] as const
/**
 * A named local profile (`--local-profile <name>`): lowercase letters, digits and
 * hyphens, at most 32, starting with a letter or digit (so never a flag). No dot or
 * slash, so a name can never leave trek-server's directories. A dev build of Trek
 * uses `dev` (or TREK_LOCAL_PROFILE), so it never shares a server with the
 * installed app.
 */
export const LOCAL_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export function isLocalProfileName(name: unknown): name is string {
  return typeof name === 'string' && LOCAL_PROFILE_NAME_RE.test(name)
}

/**
 * The profile's directory name, both under ~/.config/trek-server and under the
 * platform data dir: `local` for the default profile, `local-<name>` for a named
 * one. Throws on a name LOCAL_PROFILE_NAME_RE refuses.
 */
export function localProfileSegment(name?: string): string {
  if (name === undefined) return 'local'
  if (!isLocalProfileName(name)) throw new Error(`Invalid local profile name: ${JSON.stringify(name)}`)
  return `local-${name}`
}

/** The profile's directory as segments under the home directory: LOCAL_PROFILE_DIR, or ~/.config/trek-server/local-<name> */
export function localProfileDir(name?: string): readonly string[] {
  return ['.config', 'trek-server', localProfileSegment(name)]
}
/** The local server's config file, in the profile directory */
export const LOCAL_CONFIG_FILE = 'config.json'
/** Written (0600) once the local server listens; removed when it exits */
export const LOCAL_INFO_FILE = 'local.json'
/** Holds the local server's pid from before it reads its config until it exits */
export const LOCAL_LOCK_FILE = 'local.lock'
/** The name the local server's generated token is saved under in its config */
export const LOCAL_TOKEN_NAME = 'local'
/** `trek-server start --local` exits with this when another local server holds the lock */
export const LOCAL_ALREADY_RUNNING_EXIT = 3

/** local.json: where the running local server listens, and how to authenticate to it */
export interface LocalInfo {
  /** The WebSocket port on 127.0.0.1 */
  port: number
  pid: number
  /** The plaintext token; a new one on every start */
  token: string
  /** The server's package version */
  version: string
  /** A hash of the server bundle ("dev" from source) */
  build: string
}

/**
 * The largest pid accepted: pid_t is a signed 32-bit int on macOS and Linux
 * (whose pid_max goes up to 2**22), and Windows pids are DWORDs that stay far
 * below 2**31 in practice. A tighter bound would guard nothing: a pid in range
 * that is not the server fails the liveness and lock checks anyway.
 */
export const MAX_PID = 2 ** 31 - 1
/** A token from `addToken`: 32 random bytes in base64url (43 characters) */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/
/** A build id: 12 hex digits of the bundle's sha256, or "dev" from source */
const BUILD_RE = /^([0-9a-f]{12}|dev)$/

/** The LocalInfo in `raw`, field by field, or undefined if any field is missing or wrong. */
export function parseLocalInfo(raw: unknown): LocalInfo | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const { port, pid, token, version, build } = r
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || pid > MAX_PID) return undefined
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined
  if (typeof version !== 'string' || version === '') return undefined
  if (typeof build !== 'string' || !BUILD_RE.test(build)) return undefined
  return { port, pid, token, version, build }
}
