import type {
  GitWorktreeInfo,
  HostStatus,
  PtySpawnOptions,
  ServerConfig,
  WorktreeChanges,
  WorktreeStatus
} from '../../shared/types'
import {
  PROTOCOL_VERSION,
  type MethodName,
  type MethodParams,
  type MethodResults,
  type PtyDataEventWire,
  type PtyExitEventWire,
  type PtyInfo,
  type RemoteRepo,
  type ServerFrame,
  type WireError
} from '../../shared/protocol'
import type { HostService } from './HostService'
import { sendToPtyWindow } from './ptyWindows'

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30_000
const PING_INTERVAL_MS = 15_000
const PING_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 60_000

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: NodeJS.Timeout
}

/** Sizes a spawned/attached pty needs when we reattach after a reconnect. */
interface KnownPty {
  cwd: string
  cols: number
  rows: number
}

export class RemoteHost implements HostService {
  readonly serverId: string
  private config: ServerConfig
  private token: string
  private ws: WebSocket | null = null
  private status: HostStatus = 'disconnected'
  private pending = new Map<number, Pending>()
  private nextId = 1
  private reconnectDelay = RECONNECT_MIN_MS
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private closed = false
  /** Ptys spawned/attached through this host — reattached after reconnects. */
  private knownPtys = new Map<string, KnownPty>()
  repos: RemoteRepo[] = []
  daemonVersion = ''

  constructor(
    config: ServerConfig,
    token: string,
    private onStatus: (status: HostStatus, error?: string) => void
  ) {
    this.serverId = config.id
    this.config = config
    this.token = token
  }

  connect(): void {
    this.closed = false
    this.openSocket()
  }

  disconnect(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.stopPing()
    this.ws?.close(1000, 'client disconnect')
    this.ws = null
    this.setStatus('disconnected')
  }

  getStatus(): HostStatus {
    return this.status
  }

  updateConfig(config: ServerConfig, token: string): void {
    this.config = config
    this.token = token
  }

  private setStatus(status: HostStatus, error?: string): void {
    this.status = status
    this.onStatus(status, error)
  }

  private openSocket(): void {
    if (this.closed) return
    this.setStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.config.url)
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err))
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          token: this.token,
          client: 'trek-desktop',
          clientVersion: '0.1.0'
        })
      )
    })

    ws.addEventListener('message', (event) => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      this.onFrame(frame)
    })

    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return
      this.ws = null
      this.stopPing()
      this.failAllPending(new Error('connection closed'))
      // The daemon keeps ptys alive — tell the renderer they're detached,
      // NOT exited, so terminal state survives until we reattach.
      for (const ptyId of this.knownPtys.keys()) sendToPtyWindow('pty:detached', { id: ptyId })
      if (this.closed) return
      if (event.code === 4003) {
        this.setStatus('needs-auth', 'server rejected the access token')
        return // a bad token never fixes itself — wait for the user
      }
      this.setStatus('disconnected', event.reason || undefined)
      this.scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // 'close' always follows; reconnect is scheduled there.
    })
  }

  private onFrame(frame: ServerFrame): void {
    if (frame.type === 'welcome') {
      this.daemonVersion = frame.daemonVersion
      this.repos = frame.repos
      this.reconnectDelay = RECONNECT_MIN_MS
      this.setStatus('connected')
      this.startPing()
      void this.reattachKnownPtys()
      return
    }
    if (frame.type === 'res') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.ok) pending.resolve(frame.result)
      else pending.reject(wireError(frame.error))
      return
    }
    if (frame.type === 'event') {
      if (frame.event === 'pty.data') {
        const payload = frame.payload as PtyDataEventWire
        sendToPtyWindow('pty:data', {
          id: payload.ptyId,
          data: payload.data,
          ...(payload.replay ? { replay: true } : {})
        })
      } else if (frame.event === 'pty.exit') {
        const payload = frame.payload as PtyExitEventWire
        this.knownPtys.delete(payload.ptyId)
        sendToPtyWindow('pty:exit', { id: payload.ptyId, exitCode: payload.exitCode })
      }
      // daemon.shutdown is followed by a close frame — handled there.
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const jitter = Math.random() * 0.3 + 0.85 // ±15%
    const delay = Math.min(this.reconnectDelay * jitter, RECONNECT_MAX_MS)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delay)
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(async () => {
      try {
        await this.request('sys.ping', { t: Date.now() }, PING_TIMEOUT_MS)
      } catch {
        // Unresponsive — force the close/reconnect path.
        this.ws?.close(4000, 'ping timeout')
      }
    }, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private failAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }

  private async reattachKnownPtys(): Promise<void> {
    if (this.knownPtys.size === 0) return
    let running: PtyInfo[]
    try {
      running = await this.request('pty.list', {})
    } catch {
      return
    }
    const alive = new Set(running.map((p) => p.ptyId))
    for (const [ptyId, meta] of this.knownPtys) {
      if (alive.has(ptyId)) {
        await this.attachPty(ptyId, meta)
      } else {
        // Daemon restarted — the process is gone. Surface a real exit so the
        // renderer offers Restart (which resumes via claude --resume).
        this.knownPtys.delete(ptyId)
        sendToPtyWindow('pty:exit', { id: ptyId, exitCode: -1 })
      }
    }
  }

  /** Reset the renderer terminal, attach (replay repaints), then repaint-wiggle. */
  private async attachPty(ptyId: string, meta: KnownPty): Promise<void> {
    sendToPtyWindow('pty:reset', { id: ptyId })
    try {
      await this.request('pty.attach', { ptyId })
    } catch {
      this.knownPtys.delete(ptyId)
      sendToPtyWindow('pty:exit', { id: ptyId, exitCode: -1 })
      return
    }
    // Resize wiggle: force the TUI to fully repaint past any escape-sequence
    // truncation at the ring buffer's start.
    if (meta.cols > 1) {
      this.notify('pty.resize', { ptyId, cols: meta.cols - 1, rows: meta.rows })
      setTimeout(() => this.notify('pty.resize', { ptyId, cols: meta.cols, rows: meta.rows }), 50)
    }
  }

  request<M extends MethodName>(
    method: M,
    params: MethodParams[M],
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<MethodResults[M]> {
    const ws = this.ws
    // Requests are only valid after welcome (authed) — the daemon drops
    // anything else.
    if (!ws || ws.readyState !== WebSocket.OPEN || this.status !== 'connected') {
      return Promise.reject(new Error(`Server "${this.config.name}" is not connected`))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  /** Fire-and-forget — used on hot paths (keystrokes) where latency matters. */
  private notify<M extends MethodName>(method: M, params: MethodParams[M]): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'req', id: this.nextId++, method, params }))
  }

  git = {
    listWorktrees: (repoPath: string): Promise<GitWorktreeInfo[]> =>
      this.request('git.listWorktrees', { repoPath }),
    worktreeStatuses: (worktreePaths: string[]): Promise<WorktreeStatus[]> =>
      this.request('git.worktreeStatuses', { worktreePaths }),
    worktreeChanges: (worktreePath: string): Promise<WorktreeChanges> =>
      this.request('git.worktreeChanges', { worktreePath }),
    worktreeDiff: (worktreePath: string): Promise<Record<string, string>> =>
      this.request('git.worktreeDiff', { worktreePath }),
    listBranches: (repoPath: string): Promise<string[]> =>
      this.request('git.listBranches', { repoPath }),
    addWorktree: async (
      repoPath: string,
      worktreePath: string,
      branch: string,
      createBranch: boolean
    ): Promise<void> => {
      await this.request('git.addWorktree', { repoPath, worktreePath, branch, createBranch })
    },
    removeWorktree: async (repoPath: string, worktreePath: string): Promise<void> => {
      await this.request('git.removeWorktree', { repoPath, worktreePath })
    },
    checkout: async (repoPath: string, branch: string): Promise<void> => {
      await this.request('git.checkout', { repoPath, branch })
    },
    defaultBranch: (repoPath: string): Promise<string | null> =>
      this.request('git.defaultBranch', { repoPath }),
    exportDirtyPatch: (worktreePath: string): Promise<{ patch: string; headSha: string }> =>
      this.request('git.exportDirtyPatch', { worktreePath }),
    applyPatch: async (worktreePath: string, patch: string): Promise<void> => {
      await this.request('git.applyPatch', { worktreePath, patch })
    },
    revParseHead: (worktreePath: string): Promise<string> =>
      this.request('git.revParseHead', { worktreePath }),
    push: async (worktreePath: string, branch: string, setUpstream: boolean): Promise<void> => {
      await this.request('git.push', { worktreePath, branch, setUpstream }, 120_000)
    },
    pull: async (worktreePath: string, branch: string): Promise<void> => {
      await this.request('git.pull', { worktreePath, branch }, 120_000)
    },
    fetchBranch: async (repoPath: string, branch: string): Promise<void> => {
      await this.request('git.fetchBranch', { repoPath, branch }, 120_000)
    },
    fetchPullRequestHead: async (
      repoPath: string,
      prNumber: number,
      branch: string
    ): Promise<void> => {
      await this.request('git.fetchPullRequestHead', { repoPath, prNumber, branch }, 120_000)
    },
    addWorktreeAt: async (
      repoPath: string,
      worktreePath: string,
      branch: string
    ): Promise<void> => {
      await this.request('git.addWorktreeAt', { repoPath, worktreePath, branch })
    },
    removeWorktreeForce: async (repoPath: string, worktreePath: string): Promise<void> => {
      await this.request('git.removeWorktreeForce', { repoPath, worktreePath })
    },
    linkDirs: async (repoPath: string, worktreePath: string, dirs: string[]): Promise<void> => {
      await this.request('git.linkDirs', { repoPath, worktreePath, dirs })
    }
  }

  pty = {
    spawn: async (opts: PtySpawnOptions): Promise<void> => {
      const meta: KnownPty = { cwd: opts.cwd, cols: opts.cols, rows: opts.rows }
      if (opts.attachExisting) {
        let running: PtyInfo[] = []
        try {
          running = await this.request('pty.list', {})
        } catch {
          // fall through to spawn
        }
        if (running.some((p) => p.ptyId === opts.id)) {
          this.knownPtys.set(opts.id, meta)
          await this.attachPty(opts.id, meta)
          this.notify('pty.resize', { ptyId: opts.id, cols: opts.cols, rows: opts.rows })
          return
        }
      }
      await this.request('pty.spawn', {
        ptyId: opts.id,
        cwd: opts.cwd,
        command: opts.command,
        env: opts.env,
        cols: opts.cols,
        rows: opts.rows
      })
      this.knownPtys.set(opts.id, meta)
    },
    write: (id: string, data: string): void => {
      this.notify('pty.write', { ptyId: id, data })
    },
    resize: (id: string, cols: number, rows: number): void => {
      const meta = this.knownPtys.get(id)
      if (meta) {
        meta.cols = cols
        meta.rows = rows
      }
      this.notify('pty.resize', { ptyId: id, cols, rows })
    },
    dispose: (id: string): void => {
      this.knownPtys.delete(id)
      this.notify('pty.kill', { ptyId: id })
    },
    // The daemon keeps the session running; dropping it from knownPtys stops
    // this client streaming its output and skips it on reconnect reattach.
    detach: (id: string): void => {
      this.knownPtys.delete(id)
      this.notify('pty.detach', { ptyId: id })
    }
  }

  claude = {
    migrateSession: (sessionId: string, fromCwd: string, toCwd: string): Promise<boolean> =>
      this.request('claude.migrateSession', { sessionId, fromCwd, toCwd }),
    exportSession: async (cwd: string, sessionId: string): Promise<string | null> =>
      (await this.request('claude.exportSession', { cwd, sessionId })).content,
    importSession: async (cwd: string, sessionId: string, content: string): Promise<void> => {
      await this.request('claude.importSession', { cwd, sessionId, content }, 120_000)
    },
    deleteSession: async (cwd: string, sessionId: string): Promise<void> => {
      await this.request('claude.deleteSession', { cwd, sessionId })
    }
  }

  agents = {
    discoverCodexSession: async (cwd: string, since: number, exclude: string[]) =>
      (await this.request('agents.discoverCodexSession', { cwd, since, exclude })).sessionId,
    commandExists: async (command: string) =>
      (await this.request('agents.commandExists', { command })).exists
  }

  checkClaude(): Promise<{ available: boolean; version?: string }> {
    return this.request('claude.check', {})
  }
}

function wireError(error: WireError): Error {
  const err = new Error(error.message)
  ;(err as NodeJS.ErrnoException).code = error.code
  return err
}
