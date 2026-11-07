import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { BotEventKind } from '../../shared/bot'
import { classifyFailure, parseStreamLine } from './events.ts'

export interface TurnOptions {
  /** The command and any arguments from the project's claudeCommand. */
  command: string[]
  cwd: string
  prompt: string
  systemPrompt: string
  sessionId: string
  resume: boolean
  mcpConfig: string
  settings: string
  addDirs: string[]
  env: Record<string, string>
  timeoutMs: number
}

export type TurnOutcomeKind = 'ok' | 'crash' | 'timeout' | 'auth' | 'limit' | 'resume' | 'missing' | 'killed'

export interface TurnOutcome {
  kind: TurnOutcomeKind
  text: string
  /** The CLI reported a session, so a later turn can resume it. */
  sessionStarted: boolean
}

type TurnEnding = Omit<TurnOutcome, 'sessionStarted'>

export interface TurnHandle {
  done: Promise<TurnOutcome>
  kill: () => void
}

const KILL_GRACE_MS = 3000
/** How long stdout may stay open after the CLI exits: a descendant can hold it forever. */
const DRAIN_MS = 500
const STDERR_KEEP = 2000
const MAX_LINE = 64 * 1024 * 1024
/** The longest delay a timer can hold; anything longer would fire straight away. */
const MAX_TIMEOUT_MS = 2_147_483_647
const DEFAULT_TIMEOUT_MS = 15 * 60_000

/** The name Trek's MCP server has in the bot's config: its tools are `mcp__trek-dev__<name>`. */
export const BOT_MCP_SERVER = 'trek-dev'

/**
 * The bot's `--mcp-config`, inline. The CLI expands `${TREK_BOT_TOKEN}` from its environment, so
 * the token is in no file and not in argv (`ps` shows the placeholder).
 */
export function botMcpConfig(port: number): string {
  return JSON.stringify({
    mcpServers: {
      [BOT_MCP_SERVER]: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: 'Bearer ${TREK_BOT_TOKEN}' }
      }
    }
  })
}

export function claudeArgs(options: TurnOptions): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', options.mcpConfig,
    '--strict-mcp-config',
    '--settings', options.settings,
    '--append-system-prompt', options.systemPrompt,
    ...options.addDirs.flatMap((dir) => ['--add-dir', dir]),
    options.resume ? '--resume' : '--session-id', options.sessionId
  ]
}

/** A way to kill each turn whose process group may be alive: running, or settled but still in its SIGTERM grace. */
const liveGroups = new Set<() => void>()

/** For quitting, which can't wait out the grace: the timers die with the app, and descendants would outlive it. */
export function killAllTurnsNow(): void {
  for (const kill of [...liveGroups]) kill()
}

const finished = (ending: TurnEnding): TurnHandle => ({
  done: Promise.resolve({ ...ending, sessionStarted: false }),
  kill: () => {}
})
const ignore = (): void => {}
const NO_SHELL = 'The bot runs this command directly, without a shell, so shell aliases and env prefixes do not work.'

function spawnFailure(err: NodeJS.ErrnoException, bin: string, cwd: string): TurnEnding {
  if (err.code !== 'ENOENT') return { kind: 'crash', text: err.message }
  return existsSync(cwd)
    ? { kind: 'missing', text: `Claude CLI not found: ${bin}. ${NO_SHELL}` }
    : { kind: 'crash', text: `Working directory not found: ${cwd}` }
}

export function runTurn(
  options: TurnOptions,
  onEvent: (event: { kind: BotEventKind; text: string }) => void
): TurnHandle {
  const [bin, ...prefix] = options.command
  if (!bin) return finished({ kind: 'missing', text: 'Claude CLI not found: the command is empty' })
  let child: ChildProcess
  try {
    // detached gives the turn its own process group, so killing it reaches its children.
    child = spawn(bin, [...prefix, ...claudeArgs(options)], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    })
  } catch (err) {
    return finished(spawnFailure(err as NodeJS.ErrnoException, bin, options.cwd))
  }
  const { pid, stdin, stdout, stderr } = child
  if (!stdin || !stdout || !stderr) {
    // A failed spawn may still emit 'error', which would throw with no listener.
    child.on('error', ignore)
    if (pid !== undefined) child.kill('SIGKILL')
    return finished({ kind: 'crash', text: 'Could not open pipes to the Claude CLI: too many open files' })
  }

  let settled = false
  let stopReason: 'timeout' | 'killed' | null = null
  let drainTimer: ReturnType<typeof setTimeout> | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  const startDrain = (): void => {
    if (!settled && !drainTimer) drainTimer = setTimeout(finish, DRAIN_MS)
  }
  const signalGroup = (name: NodeJS.Signals): void => {
    try {
      process.kill(-pid!, name)
    } catch {
      // already gone
    }
  }
  const stopGroup = (reason: 'timeout' | 'killed'): void => {
    if (settled || stopReason || pid === undefined) return
    stopReason = reason
    signalGroup('SIGTERM')
    // Outlives settling on purpose, so descendants that ignore SIGTERM still die. It also ends
    // the wait if the process can't be killed at all, so the turn can never stay open.
    graceTimer = setTimeout(() => {
      signalGroup('SIGKILL')
      liveGroups.delete(killNow)
      startDrain()
    }, KILL_GRACE_MS)
    graceTimer.unref()
  }
  const killNow = (): void => {
    stopReason ??= 'killed'
    if (graceTimer) clearTimeout(graceTimer)
    signalGroup('SIGTERM')
    signalGroup('SIGKILL')
    liveGroups.delete(killNow)
    startDrain()
  }
  if (pid !== undefined) liveGroups.add(killNow)
  const requested = options.timeoutMs
  const timeout = setTimeout(
    () => stopGroup('timeout'),
    requested > 0 ? Math.min(requested, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
  )

  let result: { isError: boolean; text: string; apiStatus: number | null } | undefined
  let limited = false
  let sessionStarted = false
  const emit = (event: { kind: BotEventKind; text: string }): void => {
    try {
      onEvent(event)
    } catch (err) {
      console.error('Bot turn event listener failed', err)
    }
  }
  const handleLine = (line: string): void => {
    const parsed = parseStreamLine(line)
    parsed.events.forEach(emit)
    if (parsed.sessionId) sessionStarted = true
    if (parsed.result) result = parsed.result
    if (parsed.limited) limited = true
  }

  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let partial = ''
  let discarding = false
  const dropLongLine = (): void =>
    emit({ kind: 'error', text: 'Dropped a line of Claude output over the 64 MB limit' })
  const addOutput = (text: string): void => {
    let from = 0
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', from)) {
      const piece = text.slice(from, end)
      from = end + 1
      if (discarding) discarding = false
      else if (partial.length + piece.length > MAX_LINE) dropLongLine()
      else handleLine(partial + piece)
      partial = ''
    }
    if (discarding) return
    const rest = text.slice(from)
    if (partial.length + rest.length > MAX_LINE) {
      partial = ''
      discarding = true
      dropLongLine()
    } else {
      partial += rest
    }
  }
  let stderrText = ''
  const addStderr = (text: string): void => {
    stderrText = (stderrText + text).slice(-STDERR_KEEP)
  }
  stdout.on('data', (chunk: Buffer) => {
    if (!settled) addOutput(stdoutDecoder.write(chunk))
  })
  stderr.on('data', (chunk: Buffer) => {
    if (!settled) addStderr(stderrDecoder.write(chunk))
  })
  stdin.on('error', ignore)
  stdout.on('error', ignore)
  stderr.on('error', ignore)

  let resolveDone: (outcome: TurnOutcome) => void
  const done = new Promise<TurnOutcome>((resolve) => {
    resolveDone = resolve
  })
  const settle = (ending: TurnEnding): void => {
    if (settled) return
    settled = true
    // A stopped turn stays listed until its grace ends, for descendants that ignored SIGTERM.
    if (!stopReason) liveGroups.delete(killNow)
    clearTimeout(timeout)
    if (drainTimer) clearTimeout(drainTimer)
    stdin.destroy()
    stdout.destroy()
    stderr.destroy()
    resolveDone({ ...ending, sessionStarted })
  }
  function finish(): void {
    if (settled) return
    addOutput(stdoutDecoder.end())
    addStderr(stderrDecoder.end())
    if (partial) {
      const last = partial
      partial = ''
      handleLine(last)
    }
    if (result && !result.isError) return settle({ kind: 'ok', text: result.text })
    if (stopReason) return settle({ kind: stopReason, text: `Turn ${stopReason === 'timeout' ? 'timed out' : 'stopped'}` })
    const text = [result?.text, stderrText.trim()].filter(Boolean).join('\n') || 'Claude exited without a result'
    // stderr can quote paths and stack traces, so it only decides when the result says nothing.
    const failure = classifyFailure(result?.text || stderrText, result?.apiStatus ?? null)
    settle({ kind: failure === 'auth' || !limited ? failure : 'limit', text })
  }
  child.on('error', (err: NodeJS.ErrnoException) => settle(spawnFailure(err, bin, options.cwd)))
  child.on('exit', startDrain)
  child.on('close', finish)

  try {
    stdin.end(options.prompt)
  } catch (err) {
    console.error('Bot turn could not write its prompt', err)
  }

  return { done, kill: () => stopGroup('killed') }
}
