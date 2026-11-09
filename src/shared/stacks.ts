// A dev stack's state and URLs, from its stack.status: the stack panel's and the server's stack tools'.
import type { StackStatus } from './types'

export type StackState = 'starting' | 'running' | 'stopping' | 'stopped'

export function stackState(status: StackStatus): StackState {
  if (status.stopping) return 'stopping'
  if (status.containers > 0) return 'running'
  return status.upRunning ? 'starting' : 'stopped'
}

export const STACK_STATE_LABELS: Record<StackState, string> = {
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Stopping…',
  stopped: 'Stopped'
}

// Compose colors service prefixes even without a TTY in some versions.
export const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

export function stackUrls(status: StackStatus): { label: string; url: string }[] {
  const { slug, port } = status
  if (!slug || !port) return []
  return [
    { label: 'App', url: `http://${slug}.localhost:${port}` },
    { label: 'API', url: `http://localhost:${port + 1}` },
    ...(status.hasAdmin ? [{ label: 'Admin', url: `http://${slug}.localhost:${port + 5}` }] : [])
  ]
}
