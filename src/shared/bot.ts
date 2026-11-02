/** Types shared by the bot's host logic, the main process and the renderer. */

export type BotPhase = 'off' | 'idle' | 'working' | 'paused' | 'error'

export type WakeKind = 'heartbeat' | 'reflection' | 'chat' | 'approval'

export interface Wake {
  kind: WakeKind
  text: string
  /** Scheduled duties this wake covers, recorded as run once the turn succeeds. */
  dutyKeys?: string[]
  /** The approved approval this wake reports. Its text is then just the call, worded at turn start. */
  approvalId?: string
}

export interface ToolCall {
  tool: string
  input: Record<string, unknown>
}

export interface Approval {
  id: string
  tool: string
  input: Record<string, unknown>
  reason: string
  requestedAt: number
  status: 'pending' | 'approved'
}

export type BotEventKind = 'user' | 'wake' | 'text' | 'tool' | 'skip' | 'error' | 'approval'

export interface BotEvent {
  at: number
  kind: BotEventKind
  text: string
}

export interface BotView {
  phase: BotPhase
  /** Why the bot is paused or in error, for the panel. */
  reason: string | null
  /** A runner is behind this view, so pausing, messages and approvals reach it. */
  bound: boolean
  /** The bot's folder is missing: offer Locate and Start new. */
  folderMissing: boolean
  folder: string | null
  lastBeatAt: number | null
  nextBeatAt: number | null
  queued: number
  approvals: Approval[]
  /** Set while the user needs to act; drives the app's decision flag. */
  decision: string | null
}

export interface BotAttach {
  filePath: string
  folder?: string
  enabled: boolean
  claudeCommand: string
  repoPaths: string[]
}

export interface BotWorktreeSnapshot {
  path: string
  branch: string | null
  head: string | null
}

export interface BotSessionSnapshot {
  id: string
  worktreeId: string
  title: string
  status: string
  decision: boolean
}

export interface TrekSnapshot {
  worktrees: BotWorktreeSnapshot[]
  sessions: BotSessionSnapshot[]
}

export interface BotSnapshot extends TrekSnapshot {
  heartbeat: string
}

export const OFF_VIEW: BotView = {
  phase: 'off',
  reason: null,
  bound: false,
  folderMissing: false,
  folder: null,
  lastBeatAt: null,
  nextBeatAt: null,
  queued: 0,
  approvals: [],
  decision: null
}
