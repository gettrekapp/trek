// Trails and summits (campsite part 3c): every worktree with a branch (not a repository's main
// checkout) is a trail on its project's mountain, at one of five stages that only real milestones
// move (a commit, the pull request, green checks, the merge). Ended trails go to their project's
// history; merges count toward the camp's cairn. Pure.
import type { ActivityEvent } from '../../../src/shared/plugins/activity.ts'
import type { PluginWorktree } from '../../../src/shared/plugins/server.ts'
import type { Camp } from './camp.ts'
import { HOUR_MS, isRecord } from './catalog.ts'
import type { ShopRefusal } from './shop.ts'

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

type Trails = Pick<Camp, 'trails' | 'trailLog' | 'trailsDone'>

/** A trail for a worktree, at the trailhead from now (none when it has one, or when this branch of it already summited) */
function open(camp: Trails, projectId: string, worktreeId: string, repoId: string, branch: string, now: number): void {
  const key = trailKey(projectId, worktreeId)
  if (Object.hasOwn(camp.trails, key) || (Object.hasOwn(camp.trailsDone, key) && camp.trailsDone[key] === branch)) return
  delete camp.trailsDone[key]
  camp.trails[key] = { projectId, worktreeId, repoId, branch, stage: 0, start: now, stageAt: now }
}

/** A trail ends: into its project's history (summited if it reached the summit, else turned back), the newest TRAIL_LOG_MAX kept; a summited one's worktree starts no trail on that branch again */
function close(camp: Trails, key: string, now: number): void {
  const t = camp.trails[key]
  delete camp.trails[key]
  if (t.stage === SUMMIT) camp.trailsDone[key] = t.branch
  const log = Object.hasOwn(camp.trailLog, t.projectId) ? camp.trailLog[t.projectId] : (camp.trailLog[t.projectId] = [])
  log.push({ branch: t.branch, result: t.stage === SUMMIT ? 'summited' : 'turned-back', start: t.start, end: now })
  if (log.length > TRAIL_LOG_MAX) log.splice(0, log.length - TRAIL_LOG_MAX)
}

/** A trail at a stage from now (its clock unchanged when it is there already) */
function setStage(t: Trail, stage: number, now: number): void {
  if (t.stage === stage) return
  t.stage = stage
  t.stageAt = now
}

/** The trails a pull request's events move: every one in its project, repository and branch */
export function trailsOn(camp: Pick<Camp, 'trails'>, pr: { projectId: string; repoId: string; branch: string }): Trail[] {
  return Object.values(camp.trails).filter((t) => t.projectId === pr.projectId && t.repoId === pr.repoId && t.branch === pr.branch)
}

/**
 * One activity event's effect on the trails: a worktree made through Trek starts one; a commit
 * (`worktree.head`) moves its trail to the switchbacks, and a branch change turns it back and starts
 * one on the new branch (none when detached); a removed worktree's trail ends; a pull request's
 * events set every trail on its branch: linked the ridge, checks passed the false summit (failed: back
 * from it to the ridge), merged the summit, closed back to the switchbacks. A PR event lifts a trail
 * straight to its stage; only checks failing and a close move one down.
 */
export function trailEvent(camp: Trails, e: ActivityEvent, now: number): void {
  switch (e.kind) {
    case 'worktree.created':
      if (e.branch !== null) open(camp, e.projectId, e.worktreeId, e.repoId, e.branch, now)
      break
    case 'worktree.head': {
      const key = trailKey(e.projectId, e.worktreeId)
      if (!Object.hasOwn(camp.trails, key)) break
      const t = camp.trails[key]
      if (e.branch === t.branch) {
        if (t.stage < 1) setStage(t, 1, now)
        break
      }
      close(camp, key, now)
      if (e.branch !== null) open(camp, e.projectId, e.worktreeId, e.repoId, e.branch, now)
      break
    }
    case 'worktree.removed': {
      const key = trailKey(e.projectId, e.worktreeId)
      if (Object.hasOwn(camp.trails, key)) close(camp, key, now)
      // The worktree is gone: a summited branch's memory of it goes too
      delete camp.trailsDone[key]
      break
    }
    case 'pr.linked':
      for (const t of trailsOn(camp, e)) if (t.stage < 2) setStage(t, 2, now)
      break
    case 'pr.checks':
      for (const t of trailsOn(camp, e)) {
        if (e.result === 'passed' && t.stage < 3) setStage(t, 3, now)
        else if (e.result === 'failed' && t.stage === 3) setStage(t, 2, now)
      }
      break
    case 'pr.ended':
      for (const t of trailsOn(camp, e)) {
        if (e.result === 'merged') setStage(t, SUMMIT, now)
        else if (t.stage < SUMMIT) setStage(t, 1, now)
      }
      break
    default:
      break
  }
}

/** A worktree that is a trail: present, on a branch, not its repository's main checkout */
export const isTrailWorktree = (w: PluginWorktree): boolean => w.present && w.branch !== null && w.path !== w.repoPath

/**
 * A project's trails against its worktrees now (null: the project is gone): a qualifying worktree
 * without one starts at the trailhead (unless its branch already summited); one whose worktree is
 * gone or no longer qualifies ends; one whose branch changed turns back and starts again on the new
 * branch; a summited one ends after SUMMIT_HOLD_MS. A summited branch is forgotten once its worktree
 * is gone or on another branch.
 */
export function reconcile(camp: Trails, projectId: string, worktrees: readonly PluginWorktree[] | null, now: number): void {
  const listed = new Map<string, PluginWorktree & { branch: string }>()
  for (const w of worktrees ?? []) if (isTrailWorktree(w)) listed.set(w.id, w as PluginWorktree & { branch: string })
  for (const [key, t] of Object.entries(camp.trails)) {
    if (t.projectId !== projectId) continue
    const w = listed.get(t.worktreeId)
    if (!w || w.branch !== t.branch || (t.stage === SUMMIT && now - t.stageAt >= SUMMIT_HOLD_MS)) close(camp, key, now)
  }
  for (const w of listed.values()) open(camp, projectId, w.id, w.repoId, w.branch, now)
  const prefix = trailKey(projectId, '')
  for (const [key, branch] of Object.entries(camp.trailsDone)) {
    if (!key.startsWith(prefix)) continue
    if (listed.get(key.slice(prefix.length))?.branch !== branch) delete camp.trailsDone[key]
  }
}

/** The projects with open trails */
export const trailProjects = (camp: Pick<Camp, 'trails'>): string[] => [...new Set(Object.values(camp.trails).map((t) => t.projectId))]

/** The cairn's size, 0 (none yet) to 6, for a count of summits */
export const cairnSize = (summits: number): number => CAIRN_AT.filter((n) => summits >= n).length

/** `trailLog { projectId }`: that project's ended trails, oldest first (copies; none for a project the camp doesn't know) */
export function trailLogOf(camp: Pick<Camp, 'trailLog'>, params: Record<string, unknown>): ShopRefusal | { log: TrailRecord[] } {
  const { projectId } = params
  if (typeof projectId !== 'string') return { code: 'BAD_REQUEST', message: 'A trail log needs { projectId }' }
  const log = Object.hasOwn(camp.trailLog, projectId) ? camp.trailLog[projectId] : []
  return { log: log.map((r) => ({ ...r })) }
}
