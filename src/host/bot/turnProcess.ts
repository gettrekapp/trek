import { spawn } from 'node:child_process'
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
}

export interface TurnHandle {
  done: Promise<TurnOutcome>
  kill: () => void
}

const KILL_GRACE_MS = 3000
const STDERR_KEEP = 2000

export function claudeArgs(options: TurnOptions): string[] {
  return [
    '-p', options.prompt,
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

export function runTurn(
  options: TurnOptions,
  onEvent: (event: { kind: BotEventKind; text: string }) => void
): TurnHandle {
  const [bin, ...prefix] = options.command
  // detached gives the turn its own process group, so killing it reaches its children.
  const child = spawn(bin, [...prefix, ...claudeArgs(options)], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  })

  let stopReason: 'timeout' | 'killed' | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  const stopGroup = (reason: 'timeout' | 'killed'): void => {
    if (stopReason || child.pid === undefined) return
    stopReason = reason
    const signal = (name: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid!, name)
      } catch {
        // already gone
      }
    }
    signal('SIGTERM')
    graceTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS)
  }
  const timeout = setTimeout(() => stopGroup('timeout'), options.timeoutMs)

  let stdout = ''
  let stderr = ''
  let result: { isError: boolean; text: string; apiStatus: number | null } | undefined
  let limited = false
  const handleLine = (line: string): void => {
    const parsed = parseStreamLine(line)
    parsed.events.forEach(onEvent)
    if (parsed.result) result = parsed.result
    if (parsed.limited) limited = true
  }
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
    const lines = stdout.split('\n')
    stdout = lines.pop() ?? ''
    lines.forEach(handleLine)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEEP)
  })

  const done = new Promise<TurnOutcome>((resolve) => {
    let settled = false
    const settle = (outcome: TurnOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (graceTimer) clearTimeout(graceTimer)
      resolve(outcome)
    }
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(
        err.code === 'ENOENT'
          ? { kind: 'missing', text: `Claude CLI not found: ${bin}` }
          : { kind: 'crash', text: err.message }
      )
    })
    child.on('close', () => {
      if (stdout) handleLine(stdout)
      if (stopReason) return settle({ kind: stopReason, text: `Turn ${stopReason === 'timeout' ? 'timed out' : 'stopped'}` })
      if (result && !result.isError) return settle({ kind: 'ok', text: result.text })
      const text = [result?.text, stderr.trim()].filter(Boolean).join('\n') || 'Claude exited without a result'
      // stderr can quote paths and stack traces, so it only decides when the result says nothing.
      const failure = classifyFailure(result?.text || stderr, result?.apiStatus ?? null)
      settle({ kind: failure === 'auth' || !limited ? failure : 'limit', text })
    })
  })

  return { done, kill: () => stopGroup('killed') }
}
