/** The longest delay a timer can hold; anything longer would fire straight away. */
const MAX_DELAY_MS = 2_147_483_647
const DEFAULT_DELAY_MS = 5 * 60_000

/**
 * Fires onBeat one interval after starting, then repeatedly. The interval is reread each time,
 * and a callback that throws or a bad interval never stops the next beat being armed.
 */
export function startHeartbeat(
  getMinutes: () => number,
  onBeat: () => void,
  onScheduled: (nextAt: number) => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let lastGoodDelay = DEFAULT_DELAY_MS
  const nextDelay = (): number => {
    try {
      const delay = getMinutes() * 60_000
      if (delay > 0) lastGoodDelay = Math.min(delay, MAX_DELAY_MS)
    } catch (err) {
      console.error('Bot heartbeat could not read its interval', err)
    }
    return lastGoodDelay
  }
  const schedule = (): void => {
    const delay = nextDelay()
    if (stopped) return
    try {
      onScheduled(Date.now() + delay)
    } catch (err) {
      console.error('Bot heartbeat onScheduled failed', err)
    }
    if (stopped) return
    timer = setTimeout(() => {
      if (stopped) return
      try {
        onBeat()
      } catch (err) {
        console.error('Bot heartbeat onBeat failed', err)
      }
      schedule()
    }, delay)
  }
  schedule()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
