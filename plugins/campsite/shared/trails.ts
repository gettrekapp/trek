// Trails and summits (campsite part 3c): every worktree with a branch (not a repository's main
// checkout) is a trail on its project's mountain, at one of five stages that only real milestones
// move (a commit, the pull request, green checks, the merge). Ended trails go to their project's
// history; merges count toward the camp's cairn. Pure.
import { HOUR_MS, isRecord } from './catalog.ts'

/** The stages' names, by stage (0–4) */
export const STAGES = ['Trailhead', 'Switchbacks', 'Ridge', 'False summit', 'Summit'] as const
/** What reaches each stage, for a flag's label ("Ridge (PR open)") */
export const STAGE_HINTS = ['Trailhead', 'Switchbacks (commits)', 'Ridge (PR open)', 'False summit (checks passed)', 'Summit (merged)'] as const
export const SUMMIT = 4
/** A summited trail stays at the peak this long (or until its worktree goes) */
export const SUMMIT_HOLD_MS = 24 * HOUR_MS
/** The most ended trails a project's history keeps (the newest) */
export const TRAIL_LOG_MAX = 20
/** The cairn's sizes 1–6 start at these many summits */
export const CAIRN_AT: readonly number[] = [1, 3, 10, 25, 50, 100]

export interface Trail {
  projectId: string
  worktreeId: string
  repoId: string
  branch: string
  /** 0–4: an index of STAGES */
  stage: number
  /** When it started (ms) */
  start: number
  /** When it reached its stage (ms) */
  stageAt: number
}
export type TrailResult = 'summited' | 'turned-back'
/** An ended trail in its project's history */
export interface TrailRecord {
  branch: string
  result: TrailResult
  start: number
  end: number
}

/** A trail's key in the camp: its project and worktree */
export const trailKey = (projectId: string, worktreeId: string): string => `${projectId}:${worktreeId}`

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const str = (x: unknown): x is string => typeof x === 'string'

/** A trail this version can read */
export const isTrail = (x: unknown): x is Trail =>
  isRecord(x) && str(x.projectId) && str(x.worktreeId) && str(x.repoId) && str(x.branch) && Number.isInteger(x.stage) && (x.stage as number) >= 0 && (x.stage as number) <= SUMMIT && num(x.start) && num(x.stageAt)

/** A history entry this version can read */
export const isTrailRecord = (x: unknown): x is TrailRecord => isRecord(x) && str(x.branch) && (x.result === 'summited' || x.result === 'turned-back') && num(x.start) && num(x.end)

/** Drops what camp.json held that this version can't read: trails (or ones under another key), histories that aren't lists, history entries, summited branches that aren't names; past TRAIL_LOG_MAX, the oldest */
export function dropBadTrails(camp: { trails: Record<string, unknown>; trailLog: Record<string, unknown>; trailsDone: Record<string, unknown> }): void {
  for (const [key, t] of Object.entries(camp.trails)) if (!isTrail(t) || key !== trailKey(t.projectId, t.worktreeId)) delete camp.trails[key]
  for (const [key, branch] of Object.entries(camp.trailsDone)) if (!str(branch)) delete camp.trailsDone[key]
  for (const [projectId, log] of Object.entries(camp.trailLog)) {
    if (!Array.isArray(log)) delete camp.trailLog[projectId]
    else camp.trailLog[projectId] = log.filter(isTrailRecord).slice(-TRAIL_LOG_MAX)
  }
}
