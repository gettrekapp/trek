// Where each screen of a project is: everything about one project lives under
// app/project/[serverId]/[projectId]/ so a wide window can show it beside the project's sidebar.
// Every push to a project's screen goes through these. Pure.
import { branchParam } from './history.ts'

const P = '/project/[serverId]/[projectId]' as const
type Base = { serverId: string; projectId: string }

export const projectRoute = (serverId: string, projectId: string) => ({ pathname: P, params: { serverId, projectId } as Base })
export const worktreeRoute = (serverId: string, projectId: string, worktreeId: string) => ({ pathname: `${P}/worktree/[worktreeId]` as const, params: { serverId, projectId, worktreeId } })
export const sessionRoute = (serverId: string, projectId: string, sessionId: string) => ({ pathname: `${P}/session/[sessionId]` as const, params: { serverId, projectId, sessionId } })
export const changesRoute = (serverId: string, projectId: string, worktreeId: string) => ({ pathname: `${P}/changes/[worktreeId]` as const, params: { serverId, projectId, worktreeId } })
export const historyRoute = (serverId: string, projectId: string, repoId: string, branch: string) => ({ pathname: `${P}/history/[repoId]` as const, params: { serverId, projectId, repoId, branch: branchParam(branch) } })
export const addWorktreeRoute = (serverId: string, projectId: string, repoId: string) => ({ pathname: `${P}/add-worktree/[repoId]` as const, params: { serverId, projectId, repoId } })
export const automationsRoute = (serverId: string, projectId: string) => ({ pathname: `${P}/automations` as const, params: { serverId, projectId } as Base })
export const automationRoute = (serverId: string, projectId: string, automationId: string) => ({ pathname: `${P}/automation/[automationId]` as const, params: { serverId, projectId, automationId } })

export type SessionRoute = ReturnType<typeof sessionRoute>
export type WorktreeRoute = ReturnType<typeof worktreeRoute>

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

/**
 * Whether going to `target` leaves the project now open: `segments` are the focused route's
 * (expo-router's useSegments), `current` its params. A project's stack is one navigator for every
 * project, so a screen of another project must not be pushed into it. Pure.
 */
export function leavesProject(
  segments: readonly string[],
  current: Record<string, string | string[] | undefined>,
  target: { params: { serverId: string; projectId: string } }
): boolean {
  if (segments[0] !== 'project') return false
  return first(current.serverId) !== target.params.serverId || first(current.projectId) !== target.params.projectId
}
