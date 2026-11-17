// Tablets (and any wide window): when a project is shown as a sidebar beside a detail pane, which
// devices stay in portrait, and which sidebar row the current screen selects. Pure: the layout
// (app/project/[serverId]/[projectId]/_layout.tsx) and ui/ProjectSidebar.tsx apply it.
import { branchFromParam } from './history.ts'
import { worktreeOnBranch } from './worktreeList.ts'

/** The narrowest window, in points, that shows a project as sidebar + detail. */
export const WIDE_MIN = 700
/** The sidebar's fixed width, in points. */
export const SIDEBAR_WIDTH = 320

export function isWide(width: number): boolean {
  return width >= WIDE_MIN
}

/** Phones stay portrait; tablets, and a device whose type is unknown, rotate. (expo-device's DeviceType.PHONE is 1.) */
export function shouldLockPortrait(deviceType: number | null): boolean {
  return deviceType === 1
}

/** The sidebar's rows a screen lights up: a worktree (expanded), a session under it, and which kind of screen. */
export interface SidebarSelection {
  worktreeId: string | null
  sessionId: string | null
  screen: 'worktree' | 'session' | 'changes' | 'history' | 'automations' | 'global' | null
}

interface SelectionProject {
  repositories: readonly { id: string; worktrees: readonly { id: string; branch?: string | null; missing?: boolean; sessions: readonly { id: string }[] }[] }[]
}

type Params = Record<string, string | string[] | undefined>

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? ''

function hasWorktree(project: SelectionProject | null, id: string): boolean {
  return !!project?.repositories.some((r) => r.worktrees.some((w) => w.id === id))
}

/**
 * The selection for a route under app/project/[serverId]/[projectId]: `segments` as expo-router's
 * useSegments gives them, `params` as useGlobalSearchParams does. A Global session, an unknown id or
 * a project not loaded yet selects no worktree (ui/ProjectSidebar.tsx opens its Global group for a
 * Global session: logic/globalSessions.ts' globalGroupOpen).
 */
export function sidebarSelection(segments: readonly string[], params: Params, project: SelectionProject | null): SidebarSelection {
  const kind = segments[3]
  if (kind === 'worktree' || kind === 'changes') {
    const id = first(params.worktreeId)
    return hasWorktree(project, id) ? { worktreeId: id, sessionId: null, screen: kind } : { worktreeId: null, sessionId: null, screen: null }
  }
  if (kind === 'session') {
    const sessionId = first(params.sessionId)
    let worktreeId: string | null = null
    for (const repo of project?.repositories ?? []) for (const w of repo.worktrees) if (w.sessions.some((s) => s.id === sessionId)) worktreeId = w.id
    return { worktreeId, sessionId: sessionId || null, screen: 'session' }
  }
  if (kind === 'history') {
    const repo = project?.repositories.find((r) => r.id === first(params.repoId))
    const worktree = repo ? worktreeOnBranch(repo as { worktrees: readonly { branch: string; missing: boolean; id: string }[] }, branchFromParam(params.branch)) : undefined
    return { worktreeId: worktree?.id ?? null, sessionId: null, screen: 'history' }
  }
  if (kind === 'global') return { worktreeId: null, sessionId: null, screen: 'global' }
  if (kind === 'automations' || kind === 'automation') return { worktreeId: null, sessionId: null, screen: 'automations' }
  return { worktreeId: null, sessionId: null, screen: null }
}

interface StackState {
  routes: readonly { key?: string; name: string; state?: StackState }[]
}

/**
 * The routes of the stack inside the route `routeKey`, found in the whole navigation state (as
 * expo-router's useRootNavigationState gives it, the same state every navigator renders from).
 */
export function childRoutes(root: StackState | undefined, routeKey: string): StackState['routes'] {
  for (const route of root?.routes ?? []) {
    if (route.key === routeKey) return route.state?.routes ?? []
    const found = route.state ? childRoutes(route.state, routeKey) : null
    if (found?.length) return found
  }
  return []
}

/** The keys of the screens right above an index route: on a wide window, the screens a sidebar pick opened. */
export function aboveIndex(routes: StackState['routes']): Set<string> {
  const keys = new Set<string>()
  routes.forEach((r, i) => {
    if (i > 0 && r.key !== undefined && routes[i - 1].name === 'index') keys.add(r.key)
  })
  return keys
}
