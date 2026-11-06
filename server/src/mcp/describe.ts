// Worktrees as MCP tools see them (the desktop's describeWorktree, minus client UI state).
import { isAbsolute } from 'node:path'
import type { Project, Repository, Worktree } from '../../../src/shared/model/types'
import { codedError } from '../errors.ts'
import { realOrResolved as real } from '../repos.ts'

export function describeWorktree(project: Project, repo: Repository, w: Worktree) {
  const data = w.branch && Object.hasOwn(repo.branchData, w.branch) ? repo.branchData[w.branch] : {}
  const tagName = (id?: string) => project.settings.worktreeTags?.find((t) => t.id === id)?.name
  const customName = (id: string) => project.settings.customTags?.find((t) => t.id === id)?.name ?? id
  return {
    worktree: w.id,
    repo: repo.name,
    repoId: repo.id,
    path: w.path,
    branch: w.branch,
    primary: w.isMain,
    missing: w.missing ?? false,
    tag: tagName(data.tag),
    customTags: (data.customTags ?? []).map(customName),
    ticket: data.ticket,
    pullRequest: data.pr,
    note: data.note,
    dirty: w.dirty,
    ahead: w.ahead,
    behind: w.behind,
    loaded: w.loaded,
    sessions: w.sessions.map((s) => ({ terminalId: s.id, title: s.title, status: s.status, llm: s.llm, queue: s.queue }))
  }
}

/** A worktree by id, then path, then branch or name; a branch/name in several repositories is ambiguous. */
export function resolveWorktree(project: Project, ref: unknown): { repo: Repository; worktree: Worktree } {
  if (typeof ref !== 'string' || ref.trim() === '') throw codedError('BAD_REQUEST', 'worktree is required')
  const all = project.repositories.flatMap((repo) => repo.worktrees.map((worktree) => ({ repo, worktree })))
  const byId = all.find((x) => x.worktree.id === ref)
  if (byId) return byId
  if (isAbsolute(ref)) {
    const byPath = all.find((x) => x.worktree.path === ref || real(x.worktree.path) === real(ref))
    if (byPath) return byPath
  }
  const named = all.filter((x) => x.worktree.branch === ref || x.worktree.name === ref)
  if (named.length === 1) return named[0]
  if (named.length > 1) {
    throw codedError('BAD_REQUEST', `"${ref}" matches several worktrees; pass a path: ${named.map((x) => `${x.repo.name}: ${x.worktree.path}`).join(', ')}`)
  }
  throw codedError('NOT_FOUND', `No worktree "${ref}" in this project`)
}
