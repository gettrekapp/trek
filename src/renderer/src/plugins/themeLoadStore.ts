// Where the window is with loading its theme (theme plugins phase 2): written by ThemeHost, read
// by Settings' Theme row.
import type { ThemeLoad } from './theme.ts'

let current: ThemeLoad = { kind: 'idle' }
const listeners = new Set<() => void>()

export const getThemeLoad = (): ThemeLoad => current

export function setThemeLoad(next: ThemeLoad): void {
  if (next.kind === current.kind && (next.kind !== 'failed' || (current.kind === 'failed' && current.reason === next.reason))) return
  current = next
  for (const listener of [...listeners]) listener()
}

export function subscribeThemeLoad(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
