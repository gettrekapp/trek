// A value that may not be there yet (6a: the project's snapshot, which a promote request can
// arrive before). Pure.
export class Latest<T> {
  private value: T | null = null
  private waiting: Array<(v: T | null) => void> = []
  private closed = false

  set(value: T | null): void {
    this.value = value
    if (value === null) return
    const waiting = this.waiting
    this.waiting = []
    for (const resolve of waiting) resolve(value)
  }

  /** The value now, or the first one set; null once closed without one. */
  when(): Promise<T | null> {
    if (this.value !== null) return Promise.resolve(this.value)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  /** Nothing more will be set: whoever waits gets null. */
  close(): void {
    this.closed = true
    const waiting = this.waiting
    this.waiting = []
    for (const resolve of waiting) resolve(null)
  }
}
