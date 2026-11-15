// The Local server's listener for phones: on while phone access is enabled, at a fixed port, on
// 127.0.0.1 (for a proxy on this machine, such as `tailscale serve`) and on this machine's
// Tailscale address when it has one. It follows what is wanted (the config) and what the machine
// has (re-read every PHONE_RECHECK_MS): Tailscale starting later, or its address changing, moves it.

export type PhoneListenerState =
  | { state: 'off' }
  | { state: 'listening'; address: string; port: number }
  /** Enabled, and loopback listens, but this machine has no Tailscale address (yet) */
  | { state: 'no-tailscale' }
  | { state: 'port-in-use' }
  | { state: 'error'; error: string }

export interface PhoneListenerDeps {
  /** This machine's Tailscale address now, if it has one */
  address: () => string | undefined
  /** Listens on host:port; rejects with the listen error. `close` ends the listener and its connections. */
  listen: (host: string, port: number) => Promise<{ close(): void }>
  /** Each change of state() */
  onChange: (state: PhoneListenerState) => void
  recheckMs?: number
}

/** How often the machine's Tailscale address is read again while phone access is enabled */
export const PHONE_RECHECK_MS = 10_000
const LOOPBACK = '127.0.0.1'

const sameState = (a: PhoneListenerState, b: PhoneListenerState): boolean => JSON.stringify(a) === JSON.stringify(b)

export class PhoneListener {
  private readonly deps: PhoneListenerDeps
  private wanted = { enabled: false, port: 0 }
  private current: PhoneListenerState = { state: 'off' }
  private handles: { close(): void }[] = []
  /** What the handles listen on ("<hosts>:<port>"); '' when nothing does */
  private bound = ''
  private timer: NodeJS.Timeout | undefined
  private chain: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(deps: PhoneListenerDeps) {
    this.deps = deps
  }

  state(): PhoneListenerState {
    return this.current
  }

  /**
   * What the config asks for. Settles once the listener has followed it. The port is the caller's
   * to validate: it is handed to `listen` as given.
   */
  want(enabled: boolean, port: number): Promise<void> {
    this.wanted = { enabled, port }
    return this.check()
  }

  /** Looks at the machine again. One at a time, in order. */
  check(): Promise<void> {
    this.chain = this.chain.then(() => this.apply()).catch((err) => console.warn('[phone] listener check failed:', err))
    return this.chain
  }

  /**
   * For good: closes everything; nothing opens after, a listen still pending is closed when it
   * settles, and state() stays `off`. Silent: onChange is not called, now or later.
   */
  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    this.closeAll()
    this.current = { state: 'off' }
  }

  private async apply(): Promise<void> {
    if (this.stopped) return
    const { enabled, port } = this.wanted
    if (!enabled) {
      clearInterval(this.timer)
      this.timer = undefined
      this.closeAll()
      this.set({ state: 'off' })
      return
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.check(), this.deps.recheckMs ?? PHONE_RECHECK_MS)
      this.timer.unref()
    }
    const address = this.deps.address()
    const hosts = [...new Set([LOOPBACK, ...(address ? [address] : [])])]
    const key = `${hosts.join(',')}:${port}`
    const next: PhoneListenerState = address ? { state: 'listening', address, port } : { state: 'no-tailscale' }
    if (key === this.bound) {
      this.set(next)
      return
    }
    this.closeAll()
    try {
      for (const host of hosts) {
        const handle = await this.deps.listen(host, port)
        // Stopped while this listen was pending: stop() closed the earlier ones; this one closes here.
        if (this.stopped) {
          handle.close()
          return
        }
        this.handles.push(handle)
      }
    } catch (err) {
      this.closeAll()
      const inUse = (err as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
      this.set(inUse ? { state: 'port-in-use' } : { state: 'error', error: err instanceof Error ? err.message : String(err) })
      return
    }
    this.bound = key
    this.set(next)
  }

  private closeAll(): void {
    for (const handle of this.handles.splice(0)) handle.close()
    this.bound = ''
  }

  private set(next: PhoneListenerState): void {
    if (this.stopped) return
    if (sameState(this.current, next)) return
    this.current = next
    this.deps.onChange(next)
  }
}
