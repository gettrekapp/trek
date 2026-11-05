// Pure merges of git's view into a repository's worktree rows. The server
// keeps its own ids, sessions and `loaded`; git decides which rows exist and
// their branch, head and status.
import { basename } from 'node:path'
import type { Repository, Worktree } from '../../../src/shared/model/types'
import type { GitWorktreeInfo, WorktreeStatus } from '../../../src/shared/types'
import { realOrResolved as real } from '../repos.ts'

export interface Reconciled {
  worktrees: Worktree[]
  /** Rows were added, dropped or merged: worth writing to disk. */
  membershipChanged: boolean
  /** A row was added, restored or its head moved: statuses are stale. */
  headsChanged: boolean
}

/** Every main row matches git's main entry, whatever path either one spells. */
const MAIN_KEY = '\0main'

const keyOf = (w: { isMain: boolean; path: string }): string => (w.isMain ? MAIN_KEY : real(w.path))

function withoutStatus(w: Worktree): Worktree {
  const { dirty: _d, ahead: _a, behind: _b, ...rest } = w
  return rest
}

function displayName(w: Worktree, repo: Repository): string {
  return w.isMain ? w.name || repo.name : w.branch ?? basename(w.path)
}

export function reconcileWorktrees(repo: Repository, listed: readonly GitWorktreeInfo[], newId: () => string): Reconciled {
  let membershipChanged = false
  let headsChanged = false

  // Copies in the stored order; a duplicate path folds into its first row.
  const rows: Worktree[] = []
  const byKey = new Map<string, Worktree>()
  for (const w of repo.worktrees) {
    const key = keyOf(w)
    const first = byKey.get(key)
    if (!first) {
      const copy = { ...w, sessions: [...w.sessions] }
      byKey.set(key, copy)
      rows.push(copy)
      continue
    }
    const have = new Set(first.sessions.map((s) => s.id))
    for (const s of w.sessions) if (!have.has(s.id)) first.sessions.push(s)
    first.loaded = first.loaded || w.loaded
    membershipChanged = true
  }

  // Git flags its first entry as main, but a repository registered at a linked
  // worktree has its own checkout elsewhere in the list: prefer the entry at the
  // main row's path, else git's main. Other entries at that path are not rows.
  const mainReal = real(repo.worktrees.find((w) => w.isMain)?.path ?? repo.path)
  const mainInfo = listed.find((i) => real(i.path) === mainReal) ?? listed.find((i) => i.isMain)
  const entries: GitWorktreeInfo[] = []
  for (const i of listed) {
    if (i === mainInfo) entries.push({ ...i, isMain: true })
    else if (!i.isMain && !i.prunable && real(i.path) !== mainReal) entries.push(i)
  }

  const listedKeys = new Set<string>()
  const added: Worktree[] = []
  for (const info of entries) {
    const key = keyOf(info)
    if (listedKeys.has(key)) continue
    listedKeys.add(key)
    let row = byKey.get(key)
    if (!row) {
      row = { id: newId(), name: '', path: info.isMain ? repo.path : info.path, isMain: info.isMain, loaded: false, sessions: [] }
      added.push(row)
      byKey.set(key, row)
      membershipChanged = true
      headsChanged = true
    } else if (row.head !== info.head || row.branch !== info.branch || row.missing) {
      const index = rows.indexOf(row)
      row = withoutStatus(row)
      delete row.missing
      rows[index] = row
      byKey.set(key, row)
      headsChanged = true
    }
    if (info.branch !== undefined) row.branch = info.branch
    else delete row.branch
    if (info.head !== undefined) row.head = info.head
    else delete row.head
    row.name = displayName(row, repo)
  }

  const kept: Worktree[] = []
  for (const row of rows) {
    if (row.isMain || listedKeys.has(keyOf(row))) {
      kept.push(row)
    } else if (row.sessions.length > 0) {
      const { head: _h, ...rest } = withoutStatus(row)
      kept.push({ ...rest, missing: true })
    } else {
      membershipChanged = true
    }
  }
  return { worktrees: [...kept, ...added], membershipChanged, headsChanged }
}

/** Dirty/ahead/behind from a status read; fields the read could not get are cleared. */
export function applyStatuses(worktrees: readonly Worktree[], statuses: readonly WorktreeStatus[]): Worktree[] {
  const byPath = new Map(statuses.map((s) => [real(s.path), s]))
  return worktrees.map((w) => {
    if (w.missing) return w
    const status = byPath.get(real(w.path))
    if (!status) return w
    const next = withoutStatus(w)
    if (status.dirty !== undefined) next.dirty = status.dirty
    if (status.ahead !== undefined) next.ahead = status.ahead
    if (status.behind !== undefined) next.behind = status.behind
    return next
  })
}
