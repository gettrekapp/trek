// Sliding-window counters for the relay's limits: device registrations per address, grants per
// device, pushes per grant and per device. Each key keeps only the times inside its window; keys
// whose window has emptied are swept, at most once a second, so the maps stay as small as the
// traffic without a busy relay walking them on every request.

export class WindowLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number
  private lastSweep = 0

  constructor(limit: number, windowMs: number) {
    this.limit = limit
    this.windowMs = windowMs
  }

  private current(key: string, now: number): number[] {
    const since = now - this.windowMs
    const times = (this.hits.get(key) ?? []).filter((t) => t > since)
    if (times.length) this.hits.set(key, times)
    else this.hits.delete(key)
    return times
  }

  /** Whether a hit now would be within the limit (nothing is counted). */
  allows(key: string, now: number): boolean {
    return this.current(key, now).length < this.limit
  }

  /** Counts a hit and says whether it is within the limit (a refused hit isn't counted). */
  take(key: string, now: number): boolean {
    const times = this.current(key, now)
    if (times.length >= this.limit) return false
    times.push(now)
    this.hits.set(key, times)
    if (this.hits.size > 1_000 && now - this.lastSweep >= 1_000) this.sweep(now)
    return true
  }

  /** Keys being tracked (tests) */
  get size(): number {
    return this.hits.size
  }

  private sweep(now: number): void {
    this.lastSweep = now
    const since = now - this.windowMs
    for (const [key, times] of this.hits) if (!times.some((t) => t > since)) this.hits.delete(key)
  }
}

/** Takes one hit from each limiter only if every one of them allows it. */
export function takeAll(now: number, ...checks: [WindowLimiter, string][]): boolean {
  if (!checks.every(([limiter, key]) => limiter.allows(key, now))) return false
  for (const [limiter, key] of checks) limiter.take(key, now)
  return true
}

export const REGISTRATIONS_PER_MINUTE = 10
export const GRANTS_PER_DEVICE_PER_MINUTE = 10
export const PUSHES_PER_GRANT_PER_MINUTE = 30
export const PUSHES_PER_DEVICE_PER_HOUR = 120
