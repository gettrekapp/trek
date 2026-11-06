// scripts/clientFakes.mjs — test infrastructure for src/shared/client/:
// a manual clock, and a fake server whose sockets the tests drive by hand.
// Everything here is synchronous: events fire inside the call that causes them.

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

/**
 * A manual clock implementing the client's `Timers`.
 * - `advance(ms)` runs every job that falls due within the window, in due-time
 *   order (ties in scheduling order), moving `now()` to each job's due time
 *   before running it. Intervals re-arm at `due + interval`, and jobs scheduled
 *   by a running job also run if they fall due inside the window.
 * - `random()` returns 0.5, so the client's ±15 % jitter is exactly ×1.
 */
export function fakeTimers() {
  let now = 0
  let nextId = 1
  let nextSeq = 1
  /** handle -> { id, seq, due, fn, interval }; `seq` orders jobs due at the same time */
  const jobs = new Map()

  function schedule(fn, ms, interval) {
    const id = nextId++
    const delay = Math.max(0, Number(ms) || 0)
    jobs.set(id, { id, seq: nextSeq++, due: now + delay, fn, interval: interval ? Math.max(1, delay) : null })
    return id
  }

  function clear(handle) {
    if (handle === null || handle === undefined) return
    jobs.delete(handle)
  }

  function nextDue(limit) {
    let best = null
    for (const job of jobs.values()) {
      if (job.due > limit) continue
      if (!best || job.due < best.due || (job.due === best.due && job.seq < best.seq)) best = job
    }
    return best
  }

  const timers = {
    setTimeout: (fn, ms) => schedule(fn, ms, false),
    clearTimeout: clear,
    setInterval: (fn, ms) => schedule(fn, ms, true),
    clearInterval: clear,
    random: () => 0.5
  }

  return {
    timers,
    /** Move the clock forward by `ms`, running whatever falls due. */
    advance(ms) {
      const target = now + ms
      for (;;) {
        const job = nextDue(target)
        if (!job) break
        now = job.due
        if (job.interval !== null) {
          // Re-arm before running, so the job can clear itself.
          job.due += job.interval
          // A fresh order key, so it runs after jobs already due at that time.
          // The handle (`id`) stays the same so clearInterval still finds it.
          job.seq = nextSeq++
        } else {
          jobs.delete(job.id)
        }
        job.fn()
      }
      now = target
    },
    /** Current fake time in ms. */
    now: () => now,
    /** Number of timeouts and intervals still scheduled. */
    pending: () => jobs.size
  }
}

function fakeSocket(url) {
  const listeners = { open: [], message: [], close: [], error: [] }
  const fire = (type, event) => {
    for (const l of [...listeners[type]]) l(event)
  }

  const sock = {
    url,
    readyState: CONNECTING,
    /** Parsed frames the client sent, oldest first. */
    sent: [],
    /** `{ code, reason }` once the client called close(). */
    closedWith: null,
    listeners,

    // --- the SocketLike surface the client uses ---
    send(data) {
      if (sock.readyState === CONNECTING) throw new Error('fake socket: send() while CONNECTING')
      if (sock.readyState !== OPEN) return // a real WebSocket silently discards after close
      sock.sent.push(JSON.parse(data))
    },
    close(code, reason) {
      if (sock.readyState === CLOSED) return
      sock.closedWith = { code, reason }
      sock.readyState = CLOSED
      fire('close', { code: code ?? 1005, reason: reason ?? '' })
    },
    addEventListener(type, listener) {
      listeners[type]?.push(listener)
    },
    removeEventListener(type, listener) {
      const list = listeners[type]
      if (!list) return
      const i = list.indexOf(listener)
      if (i >= 0) list.splice(i, 1)
    },

    // --- driven by the tests (the server side) ---
    open() {
      sock.readyState = OPEN
      fire('open')
    },
    receive(frame) {
      fire('message', { data: JSON.stringify(frame) })
    },
    serverClose(code, reason = '') {
      if (sock.readyState === CLOSED) return
      sock.readyState = CLOSED
      fire('close', { code, reason })
    },
    /** Fires `error` (a real socket then fires `close`; call serverClose for that). */
    error() {
      fire('error')
    },

    // --- frame helpers ---
    welcome(extra = {}) {
      sock.receive({
        type: 'welcome',
        protocolVersion: 2,
        daemonVersion: '0.2.0',
        serverId: 'sid',
        serverName: 'box',
        capabilities: ['mcp'],
        ...extra
      })
    },
    reply(reqFrame, result) {
      if (!reqFrame) throw new Error('fake socket: reply() to a missing request')
      sock.receive({ type: 'res', id: reqFrame.id, ok: true, result })
    },
    fail(reqFrame, code, message) {
      if (!reqFrame) throw new Error('fake socket: fail() of a missing request')
      sock.receive({ type: 'res', id: reqFrame.id, ok: false, error: { code, message } })
    },
    event(event, payload) {
      sock.receive({ type: 'event', event, payload })
    },
    /** The most recent `req` frame for `method`, or undefined. */
    lastReq(method) {
      for (let i = sock.sent.length - 1; i >= 0; i--) {
        const f = sock.sent[i]
        if (f && f.type === 'req' && f.method === method) return f
      }
      return undefined
    }
  }
  return sock
}

/** A socket factory that records every socket it makes. */
export function fakeServer() {
  const sockets = []
  return {
    factory(url) {
      const sock = fakeSocket(url)
      sockets.push(sock)
      return sock
    },
    sockets,
    last: () => sockets[sockets.length - 1]
  }
}
