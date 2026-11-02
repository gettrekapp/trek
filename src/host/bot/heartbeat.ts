/** Fires onBeat one interval after starting, then repeatedly. The interval is reread each time. */
export function startHeartbeat(
  getMinutes: () => number,
  onBeat: () => void,
  onScheduled: (nextAt: number) => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const schedule = (): void => {
    const delay = getMinutes() * 60_000
    onScheduled(Date.now() + delay)
    timer = setTimeout(() => {
      if (stopped) return
      onBeat()
      schedule()
    }, delay)
  }
  schedule()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
