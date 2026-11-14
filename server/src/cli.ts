// trek-server's command line: the commands, their flags and the usage text. Pure but for
// usageError, which prints the usage and exits 2.
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { LOCAL_ALREADY_RUNNING_EXIT, isLocalProfileName } from '../../src/shared/localServer.ts'
import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocolV2.ts'
import { defaultConfigPath } from './config.ts'
import { DEFAULT_TOKEN_NAME } from './tokens.ts'

export const COMMANDS = ['start', 'stop', 'token', 'add', 'list', 'remove', 'update', 'selfcheck', 'help', 'version'] as const
const TOKEN_ACTIONS = ['add', 'list', 'revoke'] as const
/**
 * The flags that take a value. bin/trek-server (the POSIX launcher) skips each one's value when
 * it works out whether the command is `start`: keep scripts/serverLaunchers.mjs in step.
 */
export const VALUE_FLAGS = ['--id', '--name', '--config', '--port', '--host', '--data-dir', '--import-env-from', '--local-profile'] as const

export interface CliArgs {
  command: (typeof COMMANDS)[number]
  configPath: string
  /** --config was given, so the legacy trek-daemon config is not migrated */
  configExplicit: boolean
  /** `add`: the repo path. `remove`: an id or path. Both default to the current directory. */
  repoPath?: string
  repoId?: string
  repoName?: string
  /** `token <action>`; none means rotate "default" */
  tokenAction?: (typeof TOKEN_ACTIONS)[number]
  tokenName?: string
  port?: number
  host?: string
  dataDir?: string
  insecure: boolean
  /** `start --web`: serve the web client (5c-3); `web: true` in the config does the same */
  web: boolean
  /** `start --local`: the app's local server, with its own profile (see localProfile.ts). `stop --local` stops it. */
  local: boolean
  /** `--local-profile <name>`: a named local profile (local-<name>) instead of the default one */
  localProfile?: string
  /** `start --local --import-env-from <dir>`: the app's userData, whose environments the local server takes over once */
  importEnvFrom?: string
  /** `update --check`: only say whether a newer release exists */
  check: boolean
  /** `update --yes`: do not ask before installing */
  yes: boolean
}

export const USAGE = `Usage: trek-server [command] [options]
       trek-server <path>           Same as \`trek-server add <path>\`

Commands:
  start                Run the server (default)
  start --local        Run the Trek app's local server (see --local)
  stop --local         Stop the local server: server.stop (SIGTERM if it does not
                       answer), then wait for it to exit
  add [path]           Add the git repo at path (default: current directory)
  list                 List the configured repos
  remove [id|path]     Remove a repo by id or path (default: current directory)
  token                Create or rotate the token named "${DEFAULT_TOKEN_NAME}"
  token add <name>     Create or rotate a named token (one per device)
  token list           List tokens
  token revoke <name>  Revoke a token; a running server closes its connections
  update               Install the latest release, after asking. A running server restarts
                       into it: its terminals close, and agent sessions resume when their
                       worktrees are opened again
  update --check       Say whether a newer release exists; install nothing
  selfcheck            Check this install can run: node-pty, a terminal, a loopback server
  help                 Show this help
  version              Print the server version

Options:
  --config <path>   Config file (default: ${defaultConfigPath()})
  --port <port>     Port to listen on (default: config.port or ${DEFAULT_DAEMON_PORT})
  --host <host>     Interface to bind (default: config.host or 127.0.0.1)
  --insecure        Allow binding a non-loopback host without TLS
  --web             start: serve the web client (a browser build of the project window) on the
                    same port; a browser signs in by pasting a token once (config: "web": true).
                    Not with --local.
  --yes             update: do not ask before installing
  --data-dir <path> start/remove: project storage (default: config.dataDir or platform dir)
  --local           start/stop: the app's local server. Its own config, data and lock under
                    ~/.config/trek-server/local (Windows: %APPDATA%\\trek-server\\local)
                    and <platform data dir>/local; 127.0.0.1
                    on a random port; a new token on every start; any path allowed.
                    Writes the port and token to local.json there (0600) while it runs.
                    Takes none of --config, --data-dir, --port, --host, --insecure, --web.
                    Exits ${LOCAL_ALREADY_RUNNING_EXIT} if a local server is already running.
  --local-profile <name>
                    With --local: a separate local server, under local-<name> in both
                    directories (a dev build of Trek uses "dev"). The name is 1-32 of a-z, 0-9, -,
                    starting with a letter or digit.
  --import-env-from <dir>
                    With start --local: the Trek app's data dir. Once, while the local data dir
                    has no environments.json, its Colima environments registry and dev stack files
                    are copied in (the app ran them itself before; the files there are kept).
  --id <id>         add: repo id (default: slug of the directory name)
  --name <name>     add: display name (default: the directory name)
  -h, --help        Show this help
  -v, --version     Print the server version

A running server picks up repo and token changes without a restart.
To add a directory named like a command, use ./<dir>.
`

function usageError(message: string): never {
  console.error(`${message}\n\n${USAGE}`)
  process.exit(2)
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'start',
    configPath: defaultConfigPath(),
    configExplicit: false,
    insecure: false,
    web: false,
    local: false,
    check: false,
    yes: false
  }
  const value = (i: number, flag: string): string => {
    const next = argv[i]
    if (next === undefined || next.startsWith('-')) usageError(`${flag} needs a value`)
    return next
  }
  let sawCommand = false
  // -h / -v win wherever they appear, so `trek-server -h add` only prints help.
  let wantHelp = false
  let wantVersion = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const positional = !arg.startsWith('-')
    if (!sawCommand && (COMMANDS as readonly string[]).includes(arg)) {
      args.command = arg as CliArgs['command']
      sawCommand = true
    } else if (positional && args.command === 'token' && args.tokenAction === undefined) {
      if (!(TOKEN_ACTIONS as readonly string[]).includes(arg)) usageError(`Unknown token action: ${arg}`)
      args.tokenAction = arg as CliArgs['tokenAction']
    } else if (
      positional &&
      args.command === 'token' &&
      (args.tokenAction === 'add' || args.tokenAction === 'revoke') &&
      args.tokenName === undefined
    ) {
      args.tokenName = arg
    } else if (
      positional &&
      (args.command === 'add' || args.command === 'remove') &&
      args.repoPath === undefined
    ) {
      args.repoPath = arg
    } else if (positional && !sawCommand && isDirectory(arg)) {
      // `trek-server .` / `trek-server ~/repos/x` — shorthand for add.
      args.command = 'add'
      args.repoPath = arg
      sawCommand = true
    } else if (arg === '--id') args.repoId = value(++i, arg)
    else if (arg === '--name') args.repoName = value(++i, arg)
    else if (arg === '-h' || arg === '--help') wantHelp = true
    else if (arg === '-v' || arg === '--version') wantVersion = true
    else if (arg === '--config') {
      args.configPath = value(++i, arg)
      args.configExplicit = true
    } else if (arg === '--port') {
      const port = Number(value(++i, arg))
      if (!Number.isInteger(port) || port < 1 || port > 65535) usageError(`Invalid port: ${argv[i]}`)
      args.port = port
    } else if (arg === '--host') args.host = value(++i, arg)
    else if (arg === '--data-dir') args.dataDir = value(++i, arg)
    else if (arg === '--insecure') args.insecure = true
    else if (arg === '--web') args.web = true
    else if (arg === '--check') args.check = true
    else if (arg === '--yes') args.yes = true
    else if (arg === '--local') args.local = true
    else if (arg === '--import-env-from') {
      const dir = value(++i, arg)
      if (!isAbsolute(dir)) usageError(`--import-env-from needs an absolute path: ${dir}`)
      args.importEnvFrom = dir
    }
    else if (arg === '--local-profile') {
      const name = value(++i, arg)
      if (!isLocalProfileName(name)) usageError(`Invalid local profile name: ${name} (1-32 of a-z, 0-9 and -, starting with a letter or digit)`)
      args.localProfile = name
    }
    else if (positional) usageError(`Unknown command, and not a directory: ${arg}`)
    else usageError(`Unknown argument: ${arg}`)
  }
  if (wantHelp || wantVersion) {
    args.command = wantHelp ? 'help' : 'version'
    return args
  }
  if (args.local && args.command !== 'start' && args.command !== 'stop') usageError('--local only applies to `start` and `stop`')
  if ((args.check || args.yes) && args.command !== 'update') usageError('--check and --yes only apply to `update`')
  if (args.localProfile !== undefined && !args.local) usageError('--local-profile only applies with --local')
  if (args.importEnvFrom !== undefined && !(args.local && args.command === 'start')) usageError('--import-env-from only applies to `start --local`')
  if (args.command === 'stop' && !args.local) usageError('`stop` only stops the local server: `trek-server stop --local`')
  if (args.local && (args.configExplicit || args.dataDir !== undefined || args.port !== undefined || args.host !== undefined || args.insecure)) {
    usageError('--local has its own config, data dir, host and port: drop --config, --data-dir, --port, --host and --insecure')
  }
  // The Local server is the app's own: no browser ever signs in to it.
  if (args.local && args.web) usageError('--web does not apply to the local server')
  if ((args.port !== undefined || args.host !== undefined || args.insecure || args.web) && args.command !== 'start') {
    usageError('--port, --host, --insecure and --web only apply to `start`')
  }
  if (args.dataDir !== undefined && args.command !== 'start' && args.command !== 'remove') {
    usageError('--data-dir only applies to `start` and `remove`')
  }
  if ((args.repoId !== undefined || args.repoName !== undefined) && args.command !== 'add') {
    usageError('--id and --name only apply to `add`')
  }
  if ((args.tokenAction === 'add' || args.tokenAction === 'revoke') && args.tokenName === undefined) {
    usageError(`\`token ${args.tokenAction}\` needs a name`)
  }
  return args
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
