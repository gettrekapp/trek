// Background push (6b): the vocabulary shared by trek-server, trek-relay and the phone. A push
// carries a kind and a project name only; the relay builds the words from this table, so a
// server can never put arbitrary text (terminal output, a decision's question, a branch) on a
// lock screen. Dependency-free: the phone imports it (scripts/sharedForMobile.test.mjs).

/** What happened, as a push names it */
export const PUSH_KINDS = [
  'decision',
  'session-finished',
  'session-stopped',
  'pr-checks-failed',
  'pr-checks-passed',
  'pr-review',
  'pr-conflict',
  'pr-merged',
  'pr-closed'
] as const
export type PushKind = (typeof PUSH_KINDS)[number]

/** The phone's three switches, per paired server */
export type PushGroup = 'decisions' | 'sessions' | 'prWatch'
export const PUSH_GROUPS: readonly PushGroup[] = ['decisions', 'sessions', 'prWatch']

export function pushGroupOf(kind: PushKind): PushGroup {
  if (kind === 'decision') return 'decisions'
  if (kind === 'session-finished' || kind === 'session-stopped') return 'sessions'
  return 'prWatch'
}

export function isPushKind(value: unknown): value is PushKind {
  return typeof value === 'string' && (PUSH_KINDS as readonly string[]).includes(value)
}

const BODIES: Record<PushKind, string> = {
  decision: 'A decision is waiting',
  'session-finished': 'A session is waiting for you',
  'session-stopped': 'A session stopped',
  'pr-checks-failed': 'Pull request checks failed',
  'pr-checks-passed': 'Pull request checks passed',
  'pr-review': 'New pull request review comments',
  'pr-conflict': 'The pull request has a merge conflict',
  'pr-merged': 'The pull request was merged',
  'pr-closed': 'The pull request was closed'
}

/** Longest project name a push carries; longer ones are cut with an ellipsis */
export const MAX_PUSH_PROJECT = 80
/** Longest id in a push's `data` */
export const MAX_PUSH_ID = 128

/**
 * Cuts a project name to MAX_PUSH_PROJECT code points (a surrogate pair is never split) and drops
 * control characters and the invisible ones that can reorder or hide text: zero-width and bidi
 * marks, the line and paragraph separators (U+2028/2029), the BOM (U+FEFF) and the invisible
 * operators (U+2060–2064).
 */
export function pushProject(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').trim()
  const points = Array.from(clean)
  return points.length > MAX_PUSH_PROJECT ? `${points.slice(0, MAX_PUSH_PROJECT - 1).join('')}…` : clean
}

/** The words on the lock screen: "Trek · <project>" over the kind's fixed sentence. */
export function pushText(kind: PushKind, project: string): { title: string; body: string } {
  const name = pushProject(project)
  return { title: name ? `Trek · ${name}` : 'Trek', body: BODIES[kind] }
}

/** The ids the phone uses to open the right screen when the push is tapped */
export interface PushData {
  serverId: string
  projectId: string
  worktreeId?: string
  sessionId?: string
}

/** `POST /v1/push`'s body (from a server, bearer: its grant secret) */
export interface RelayPushBody {
  kind: PushKind
  project: string
  data: PushData
}

/** The switches a phone sets on a server (`push.setGrant`) */
export interface PushKinds {
  decisions: boolean
  sessions: boolean
  prWatch: boolean
}

export const ALL_PUSH_KINDS_ON: PushKinds = { decisions: true, sessions: true, prWatch: true }
