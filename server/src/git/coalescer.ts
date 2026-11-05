// Serializes async jobs per key. A run() while a job for the key is in flight
// queues one follow-up; every caller that arrives before it starts shares it.
// So a caller always gets a job that started after its call, and a burst of
// callers costs at most one extra run.
//
// Use one key per kind of job: a shared follow-up runs the first queued
// caller's `job`. A job must settle (git calls time out), and must never await
// run() for its own key or for a key that awaits it back: that deadlocks the
// key for good, since every later caller would share the stuck follow-up.
const ignore = (): void => {}

export class Coalescer {
  private readonly running = new Map<string, Promise<unknown>>()
  private readonly queued = new Map<string, Promise<unknown>>()

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const queued = this.queued.get(key)
    if (queued) return queued as Promise<T>
    const current = this.running.get(key)
    if (!current) return this.start(key, job)
    const next = current.then(ignore, ignore).then(() => {
      this.queued.delete(key)
      return this.start(key, job)
    })
    this.queued.set(key, next)
    return next
  }

  private start<T>(key: string, job: () => Promise<T>): Promise<T> {
    const tracked: Promise<T> = Promise.resolve()
      .then(job)
      .finally(() => {
        if (this.running.get(key) === tracked) this.running.delete(key)
      })
    this.running.set(key, tracked)
    return tracked
  }
}
