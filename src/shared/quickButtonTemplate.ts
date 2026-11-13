import type { ProjectFile, Repository } from './types'

// Quick button templates: {INPUT} asks the user, [builtin] is filled from the
// clicked terminal's context. Shared so the parser is unit-tested in node.

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'input'; name: string; raw: string }
  | { kind: 'builtin'; name: string; raw: string }

export type BuiltinGroup = 'Worktree' | 'Repo & project' | 'Branch' | 'Session' | 'Time'

export interface BuiltinDef {
  name: string
  description: string
  group: BuiltinGroup
}

export const BUILTINS: readonly BuiltinDef[] = [
  { name: 'worktree_id', description: 'Worktree id', group: 'Worktree' },
  { name: 'worktree_name', description: 'Worktree display name', group: 'Worktree' },
  { name: 'worktree_path', description: 'Worktree path on its host', group: 'Worktree' },
  { name: 'branch', description: 'Current branch', group: 'Worktree' },
  { name: 'repo_name', description: 'Repository name', group: 'Repo & project' },
  { name: 'repo_path', description: 'Repository main checkout path', group: 'Repo & project' },
  { name: 'project_name', description: 'Project name', group: 'Repo & project' },
  { name: 'workflow_tag', description: "Branch's workflow tag", group: 'Branch' },
  { name: 'labels', description: "Branch's custom tags, comma-separated", group: 'Branch' },
  { name: 'ticket', description: 'Linked ticket id', group: 'Branch' },
  { name: 'ticket_url', description: 'Linked ticket URL', group: 'Branch' },
  { name: 'pr_url', description: 'Linked pull request URL', group: 'Branch' },
  { name: 'pr_number', description: 'Linked pull request number', group: 'Branch' },
  { name: 'note', description: "Branch's note", group: 'Branch' },
  { name: 'session_title', description: 'Session tab title', group: 'Session' },
  { name: 'session_id', description: "Agent's session id", group: 'Session' },
  { name: 'terminal_id', description: 'Trek terminal id', group: 'Session' },
  { name: 'agent', description: 'Agent name, e.g. Claude', group: 'Session' },
  { name: 'date', description: 'Today, YYYY-MM-DD', group: 'Time' },
  { name: 'time', description: 'Now, HH:MM', group: 'Time' }
]

const BUILTIN_NAMES = new Set(BUILTINS.map((b) => b.name))
const TOKEN = /\{([A-Za-z0-9_]+)\}|\[([A-Za-z_]+)\]/g

export function isBuiltinName(name: string): boolean {
  return BUILTIN_NAMES.has(name.toLowerCase())
}

export function parseTemplate(text: string): Segment[] {
  const out: Segment[] = []
  const pushText = (t: string): void => {
    if (!t) return
    const prev = out[out.length - 1]
    if (prev?.kind === 'text') prev.text += t
    else out.push({ kind: 'text', text: t })
  }
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index ?? 0
    const end = index + m[0].length
    if (m[2] !== undefined) {
      // Unknown names and markdown links ("[branch](url)") are plain text.
      if (!isBuiltinName(m[2]) || text[end] === '(') continue
    }
    pushText(text.slice(last, index))
    out.push(
      m[1] !== undefined
        ? { kind: 'input', name: m[1], raw: m[0] }
        : { kind: 'builtin', name: m[2].toLowerCase(), raw: m[0] }
    )
    last = end
  }
  pushText(text.slice(last))
  return out
}

function uniqueNames(text: string, kind: 'input' | 'builtin'): string[] {
  const names: string[] = []
  for (const s of parseTemplate(text)) {
    if (s.kind === kind && !names.includes(s.name)) names.push(s.name)
  }
  return names
}

/** The `{NAME}` inputs, once each, in order of first appearance. */
export function templateInputs(text: string): string[] {
  return uniqueNames(text, 'input')
}

/** The known `[name]` built-ins, once each, in order of first appearance. */
export function templateBuiltins(text: string): string[] {
  return uniqueNames(text, 'builtin')
}

/** What the built-ins are resolved from; the renderer builds it from the store. */
export interface BuiltinContext {
  project: Pick<ProjectFile, 'name' | 'worktreeTags' | 'customTags'>
  /** A ticket's link through the project's trackers (plugin system phase 2), or null */
  ticketUrl(ticketId: string): string | null
  /** Undefined in the Global panel */
  repo?: Pick<
    Repository,
    'name' | 'path' | 'branchTags' | 'branchCustomTags' | 'branchTickets' | 'branchPullRequests' | 'branchNotes'
  >
  worktree?: { id: string; name: string; path: string }
  branch?: string
  terminal: { id: string; title: string; sessionId: string; sessionPending?: boolean }
  /** Agent label, e.g. "Claude" */
  agent: string
  now: Date
}

export type BuiltinValues = Record<string, string | undefined>

const present = (value: string | null | undefined): string | undefined =>
  value && value.trim() ? value : undefined

const pad = (n: number): string => String(n).padStart(2, '0')

function prNumber(url: string | undefined): string | undefined {
  if (!url) return undefined
  return url.match(/\/pull\/(\d+)/)?.[1] ?? url.match(/(\d+)\/?$/)?.[1]
}

/** Every built-in's value for this context; undefined = no value here. */
export function resolveBuiltins(ctx: BuiltinContext): BuiltinValues {
  const { project, repo, worktree, branch, terminal, now, ticketUrl } = ctx
  const byBranch = <T>(map: Record<string, T> | undefined): T | undefined =>
    branch && map ? map[branch] : undefined
  const tagId = byBranch(repo?.branchTags)
  const customIds = byBranch(repo?.branchCustomTags) ?? []
  const ticket = present(byBranch(repo?.branchTickets))
  const prUrl = present(byBranch(repo?.branchPullRequests))
  return {
    worktree_id: present(worktree?.id),
    worktree_name: present(worktree?.name),
    worktree_path: present(worktree?.path),
    branch: present(branch),
    repo_name: present(repo?.name),
    repo_path: present(repo?.path),
    project_name: present(project.name),
    workflow_tag: present(tagId ? project.worktreeTags?.find((t) => t.id === tagId)?.name : undefined),
    labels: present(
      (project.customTags ?? [])
        .filter((t) => customIds.includes(t.id))
        .map((t) => t.name)
        .join(', ')
    ),
    ticket,
    ticket_url: ticket ? present(ticketUrl(ticket)) : undefined,
    pr_url: prUrl,
    pr_number: prNumber(prUrl),
    note: present(byBranch(repo?.branchNotes)),
    session_title: present(terminal.title),
    session_id: terminal.sessionPending ? undefined : present(terminal.sessionId),
    terminal_id: present(terminal.id),
    agent: present(ctx.agent),
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`
  }
}

/** The final text: inputs from `inputs`, built-ins from `builtins`; anything missing is blank. */
export function fillTemplate(segments: Segment[], inputs: Record<string, string>, builtins: BuiltinValues): string {
  return segments
    .map((s) => (s.kind === 'text' ? s.text : s.kind === 'input' ? (inputs[s.name] ?? '') : (builtins[s.name] ?? '')))
    .join('')
}

export interface QuickButtonPlan {
  inputs: string[]
  /** Built-ins the text uses that have no value here */
  missing: string[]
  /** Whether clicking opens the run modal rather than sending at once */
  needsModal: boolean
}

export function planQuickButton(text: string, builtins: BuiltinValues): QuickButtonPlan {
  const inputs = templateInputs(text)
  const missing = templateBuiltins(text).filter((name) => builtins[name] === undefined)
  return { inputs, missing, needsModal: inputs.length > 0 || missing.length > 0 }
}
