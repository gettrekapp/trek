import type { SessionStatus } from '../shared.ts'
import { colors } from './theme.ts'

export const STATUS_TEXT: Record<SessionStatus, string> = {
  working: 'Working',
  attention: 'Needs you',
  done: 'Done',
  complete: 'Complete',
  idle: 'Idle',
  exited: 'Exited'
}

export function statusColor(status: SessionStatus): string {
  return status === 'attention' ? colors.attention : status === 'working' ? colors.accent : status === 'done' ? colors.ok : colors.muted
}
