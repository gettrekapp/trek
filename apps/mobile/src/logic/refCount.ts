// Counts users of a shared thing by key (6a: promote.listen per project, which several mounted
// project screens can want at once). Pure.
export class RefCounts {
  private readonly counts = new Map<string, number>()

  /** True when this is the first user of the key (the caller turns it on). */
  acquire(key: string): boolean {
    const n = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, n)
    return n === 1
  }

  /** True when this was the last user of the key (the caller turns it off). */
  release(key: string): boolean {
    const n = this.counts.get(key) ?? 0
    if (n <= 1) {
      this.counts.delete(key)
      return n === 1
    }
    this.counts.set(key, n - 1)
    return false
  }

  has(key: string): boolean {
    return this.counts.has(key)
  }
}
