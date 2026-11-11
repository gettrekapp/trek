// Sliding-window counters for the relay's limits: device registrations per address, pushes per
// grant and per device. Each key keeps only the times inside its window, and a key whose window
// has emptied is dropped, so the maps stay as small as the traffic.

export class WindowLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number

  constructor(limit: number, windowMs: number) {
    this.limit = limit
    this.windowMs = windowMs
  }

  /** Counts a hit and says whether it is within the limit (a refused hit isn't counted). */
  take(key: string, now: number): boolean {
    const since = now - this.windowMs
    const times = (this.hits.get(key) ?? []).filter((t) => t > since)
    if (times.length >= this.limit) {
      this.hits.set(key, times)
      return false
    }
    times.push(now)
    this.hits.set(key, times)
    if (this.hits.size > 10_000) this.sweep(now)
    return true
  }

  private sweep(now: number): void {
    const since = now - this.windowMs
    for (const [key, times] of this.hits) if (!times.some((t) => t > since)) this.hits.delete(key)
  }
}

export const REGISTRATIONS_PER_MINUTE = 10
export const PUSHES_PER_GRANT_PER_MINUTE = 30
export const PUSHES_PER_DEVICE_PER_HOUR = 120
