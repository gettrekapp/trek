// What a hiker does for its session's status, the chore a working one does, and its words (aria
// label, the tab's title, the camp's tooltip). A working hiker's chore follows its agent's latest
// tool call when there is one (campsite part 4), else a seeded random one. Pure.
import type { PluginSession, PluginSessionStatus } from '../../../src/shared/plugins/client.ts'
import type { AgentToolKind } from '../../../src/shared/plugins/agents.ts'
import { fnv1a, type Gear } from './hiker.ts'
import type { Pose } from './pixels.ts'

/** The chores a working hiker picks at random while its agent reports no tool calls */
export const CHORES = ['map', 'chop', 'tent', 'fire'] as const
/** Every chore: the random four, the web's binoculars, an MCP tool's radio, and thinking between tool calls */
export type Chore = (typeof CHORES)[number] | 'binoculars' | 'radio' | 'think'
export const CHORE_NAMES: Readonly<Record<Chore, string>> = {
  map: 'reading the map',
  chop: 'chopping wood',
  tent: 'pitching the tent',
  fire: 'tending the fire',
  binoculars: 'scanning the trail',
  radio: 'on the radio',
  think: 'thinking'
}

/** A session's latest tool call, as a window keeps it: its kind, its label, and when it was heard of (this window's ms) */
export interface HikerTool {
  kind: AgentToolKind
  label: string
  at: number
}

/** How long a tool call holds its chore; after it the hiker thinks until the next one */
export const TOOL_FRESH_MS = 8000
/**
 * How long a hiker thinks after its last tool call; after it the call is forgotten and the hiker
 * goes back to the random chores (a `/clear` starts a transcript the reader doesn't follow, and an
 * agent may stop reporting without a word: it shouldn't think forever)
 */
export const TOOL_STALE_MS = 120_000

/** The chore each kind of tool call shows */
export const TOOL_CHORES: Readonly<Record<AgentToolKind, Chore>> = {
  read: 'map',
  edit: 'chop',
  run: 'fire',
  delegate: 'tent',
  web: 'binoculars',
  mcp: 'radio',
  other: 'map'
}
/** A kind's chore; a kind this version doesn't know is other's */
const kindChore = (kind: string): Chore => (Object.hasOwn(TOOL_CHORES, kind) ? TOOL_CHORES[kind as AgentToolKind] : TOOL_CHORES.other)

/** The tool call a hiker still shows at `now`: null once it is TOOL_STALE_MS old (or there is none) */
export function liveTool(tool: HikerTool | null | undefined, now: number): HikerTool | null {
  return tool && now - tool.at < TOOL_STALE_MS ? tool : null
}

/**
 * A working hiker's chore at `now` (ms): with a tool call younger than TOOL_FRESH_MS, its kind's
 * chore; with one up to TOOL_STALE_MS old, thinking; with none (or an older one), a seeded pick that
 * holds for a seeded 20–40 s. Its words (choreText, hikerDoing, hikerTooltip) take `liveTool`'s call,
 * so a stale call's kind never names a random chore.
 */
export function choreFor(terminalId: string, now: number, tool?: HikerTool | null): Chore {
  const live = liveTool(tool, now)
  if (live) return now - live.at < TOOL_FRESH_MS ? kindChore(live.kind) : 'think'
  const seed = fnv1a(terminalId)
  const period = 20_000 + (seed % 20_001)
  const index = Math.floor((now + (seed % period)) / period)
  return CHORES[fnv1a(`${terminalId}:${index}`) % CHORES.length]
}

/** A tool call in words: "Editing Campsite.tsx", "Running npm test", "On the radio: trek-dev list_worktrees" */
export function toolWords(tool: Pick<HikerTool, 'kind' | 'label'>): string {
  const l = tool.label
  switch (tool.kind) {
    case 'read':
      return l ? `Reading ${l}` : 'Reading'
    case 'edit':
      return l ? `Editing ${l}` : 'Editing'
    case 'run':
      return l ? `Running ${l}` : 'Running a command'
    case 'delegate':
      return l ? `Sending a scout: ${l}` : 'Sending a scout'
    case 'web':
      return l ? `Looking up ${l}` : 'Looking something up'
    case 'mcp':
      return l ? `On the radio: ${l}` : 'On the radio'
    default:
      return l ? `Using ${l}` : 'Busy'
  }
}

/** A chore in words: thinking; the tool call it shows (its own chore, from choreFor with that tool); else the chore's name */
export function choreText(chore: Chore, tool?: HikerTool | null): string {
  if (chore === 'think') return 'Thinking'
  if (tool && kindChore(tool.kind) === chore) return toolWords(tool)
  return CHORE_NAMES[chore]
}

/** Waiting on the user: its bell rang, or it asked for a decision */
export const isWaiting = (s: Pick<PluginSession, 'status' | 'decision'>): boolean => s.status === 'attention' || s.decision

/**
 * What a tab's hiker draws: the session as the host lists it, or, before the host lists it (or once
 * it no longer does), the tab's own status with no decision; with neither, idle (a sleeping hiker).
 * A tab never goes blank.
 */
export function indicatorState(session: Pick<PluginSession, 'status' | 'decision'> | undefined, status: PluginSessionStatus | null): Pick<PluginSession, 'status' | 'decision'> {
  if (session) return { status: session.status, decision: session.decision }
  return { status: status ?? 'idle', decision: false }
}

/** What a waiting hiker's sign says: the bell rang, or a decision is pending */
export type Sign = 'attention' | 'decision'
export const SIGN_TEXT: Readonly<Record<Sign, string>> = { attention: '!', decision: '?' }
/** The core's tokens, with their values as fallbacks */
export const SIGN_COLORS: Readonly<Record<Sign, string>> = { attention: 'var(--attention, #e2a336)', decision: 'var(--decision, #b18cff)' }
/** Each glyph's filled cells, [x, y] on a 3×5 grid */
export const SIGN_GLYPHS: Readonly<Record<Sign, readonly (readonly [number, number])[]>> = {
  attention: [[1, 0], [1, 1], [1, 2], [1, 4]],
  decision: [[0, 0], [1, 0], [2, 0], [2, 1], [1, 2], [1, 4]]
}

export interface Stance {
  pose: Pose
  /** What the hands hold instead of the look's own */
  gear?: Gear | 'none'
  grey: boolean
  /** The sign it waves under, if it is waiting */
  sign: Sign | null
}

// The `stand` pose is reserved: drawn by pixels.ts, not returned here yet.
export function stanceFor(session: Pick<PluginSession, 'status' | 'decision'>, chore: Chore): Stance {
  // A pending decision says more than a bell
  if (isWaiting(session)) return { pose: 'wave', gear: 'none', grey: false, sign: session.decision ? 'decision' : 'attention' }
  switch (session.status) {
    case 'working':
      return { pose: chore, grey: false, sign: null }
    case 'starting':
      return { pose: 'walk', grey: false, sign: null }
    case 'done':
      return { pose: 'cheer', gear: 'none', grey: false, sign: null }
    case 'complete':
      return { pose: 'sit', gear: 'mug', grey: false, sign: null }
    case 'exited':
      return { pose: 'sit', gear: 'none', grey: true, sign: null }
    default:
      return { pose: 'sleep', grey: false, sign: null }
  }
}

const STATUS_TEXT: Readonly<Record<PluginSessionStatus, string>> = {
  starting: 'starting',
  working: 'working',
  attention: 'needs your attention',
  done: 'finished',
  complete: 'marked complete',
  idle: 'idle',
  exited: 'exited'
}

export function statusText(session: Pick<PluginSession, 'status' | 'decision'>): string {
  if (session.decision) return 'waiting on your decision'
  return Object.hasOwn(STATUS_TEXT, session.status) ? STATUS_TEXT[session.status] : 'idle'
}

export const hikerLabel = (session: PluginSession): string => `${session.label}, ${statusText(session)}`

// The core StatusBadge's titles, so a hiker on a tab says the same, except idle: core shows no badge
// for it, but a sleeping hiker still needs a title. Unknown statuses fall back to idle's.
const TITLES: Readonly<Record<PluginSessionStatus, string>> = {
  starting: 'Starting…',
  working: 'Agent is working',
  attention: 'Agent needs your attention',
  done: 'Agent finished',
  complete: 'Marked complete — status tracking paused',
  idle: 'Agent is idle',
  exited: 'Process exited'
}

export function statusTitle(status: PluginSessionStatus, clickable: boolean): string {
  const title = Object.hasOwn(TITLES, status) ? TITLES[status] : TITLES.idle
  if (!clickable) return title
  if (status === 'done') return `${title} — click to mark fully complete`
  if (status === 'complete') return `${title} — click to resume tracking`
  return title
}

/** A tab's indicator's title: a pending decision says so (the chip's "?" has no words of its own); else the status's */
export function indicatorTitle(state: Pick<PluginSession, 'status' | 'decision'>, clickable: boolean): string {
  return state.decision ? 'Agent is waiting on your decision' : statusTitle(state.status, clickable)
}

/** What a session's hiker is up to, in words: its chore while working (`tool`: the call it shows), else its status */
export function hikerDoing(session: Pick<PluginSession, 'status' | 'decision'>, chore: Chore, tool?: HikerTool | null): string {
  return session.status === 'working' && !isWaiting(session) ? choreText(chore, tool) : statusText(session)
}

/** The hiker's tooltip; `crew` (its crew member, or "Day hiker") leads once the camp's state is loaded; `tool`: the call its chore shows */
export function hikerTooltip(session: PluginSession, chore: Chore, crew?: string, tool?: HikerTool | null): string {
  const where = session.worktreeId === null ? 'Global' : (session.worktreeName ?? session.branch ?? '')
  const parts = [crew, session.label, where, statusText(session)]
  if (session.status === 'working' && !isWaiting(session)) parts.push(choreText(chore, tool))
  return parts.filter(Boolean).join(' · ')
}
