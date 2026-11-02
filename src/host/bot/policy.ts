import { basename, relative, resolve, sep } from 'node:path'
import type { Approval, ToolCall } from '../../shared/bot'

export interface PolicyOverrides {
  /** Tool names without the MCP prefix, or `bash:<name>` from ASK_SHELL. */
  free?: string[]
  ask?: string[]
}

export interface PolicyContext {
  folder: string
  secretPaths: string[]
  overrides: PolicyOverrides
  approvals: Approval[]
}

export interface PolicyDecision {
  decision: 'allow' | 'ask' | 'deny'
  reason: string
  approvalId?: string
}

const TREK_PREFIX = 'mcp__trek-dev__'

const FREE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'ToolSearch', 'TodoWrite',
  'list_worktrees', 'get_selected_worktree', 'list_session_types',
  'start_session', 'send_prompt', 'enqueue_prompt', 'remove_queued_prompt',
  'read_terminal', 'wait_for_sessions', 'create_worktree', 'load_worktree',
  'get_stack', 'start_stack', 'stop_stack', 'read_stack_log',
  'set_worktree_tag', 'set_worktree_custom_tag', 'set_worktree_note',
  'set_worktree_ticket', 'set_worktree_pull_request', 'request_approval'
])

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const ASK_SHELL: Record<string, RegExp> = {
  'git push': /\bgit\s+push\b/,
  'git merge': /\bgit\s+merge\b/,
  'git worktree remove': /\bgit\s+worktree\s+remove\b/,
  'git branch -D': /\bgit\s+branch\s+-D\b/,
  'gh pr create': /\bgh\s+pr\s+create\b/,
  'gh pr merge': /\bgh\s+pr\s+merge\b/
}

const FORCE_PUSH = /\bgit\s+push\b.*(\s--force\b|\s--force-with-lease\b|\s-f\b)/
const SHELL_WRITE_TO_PROTECTED =
  /(>|\btee\b|\bsed\s+-i\b|\bmv\b|\bcp\b|\brm\b|\btouch\b|\bchmod\b)[^|;&]*(BOT\.md|POLICY\.json|config\.json|state\/)/

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  )

/** Bash matches on the command alone: the model rewrites `description` freely. */
function callKey(tool: string, input: Record<string, unknown>): string {
  return tool === 'Bash' ? `Bash:${String(input.command ?? '')}` : `${tool}:${stable(input)}`
}

export function approvalMatches(approval: Approval, call: ToolCall): boolean {
  return callKey(approval.tool, approval.input) === callKey(call.tool, call.input)
}

function inFolder(folder: string, path: string): string | null {
  const rel = relative(folder, resolve(folder, path))
  return rel === '' || rel.startsWith('..') ? null : rel
}

function isProtected(rel: string): boolean {
  return rel === 'BOT.md' || rel === 'POLICY.json' || rel === 'config.json' || rel === `state` || rel.startsWith(`state${sep}`)
}

function isBotWritable(rel: string): boolean {
  return (
    rel === 'HEARTBEAT.md' ||
    rel === 'MEMORY.md' ||
    rel.startsWith(`knowledge${sep}`) ||
    rel.startsWith(`journal${sep}`)
  )
}

function neverReason(call: ToolCall, ctx: PolicyContext): string | null {
  const { tool, input } = call
  if (tool === 'Bash') {
    const command = String(input.command ?? '')
    if (FORCE_PUSH.test(command)) return 'Force-pushing is never allowed.'
    if (SHELL_WRITE_TO_PROTECTED.test(command)) return 'Protected bot files cannot be changed.'
    if (ctx.secretPaths.some((p) => command.includes(p) || command.includes(basename(p)))) {
      return "Trek's secret stores cannot be read."
    }
    return null
  }
  const path = input.file_path ?? input.notebook_path
  if (typeof path !== 'string') return null
  if (tool === 'Read' && ctx.secretPaths.includes(resolve(ctx.folder, path))) {
    return "Trek's secret stores cannot be read."
  }
  if (FILE_WRITE_TOOLS.has(tool)) {
    const rel = inFolder(ctx.folder, path)
    if (rel !== null && isProtected(rel)) return 'Protected bot files cannot be changed.'
  }
  return null
}

function askReason(call: ToolCall): string {
  return `Needs approval. Call ${TREK_PREFIX}request_approval with tool "${call.tool}", this exact input and a reason, then end your turn. The result arrives in a later turn.`
}

function tierOf(call: ToolCall, ctx: PolicyContext): 'allow' | 'ask' {
  const name = call.tool.startsWith(TREK_PREFIX) ? call.tool.slice(TREK_PREFIX.length) : call.tool
  const free = ctx.overrides.free ?? []
  const ask = ctx.overrides.ask ?? []
  if (call.tool === 'Bash') {
    const command = String(call.input.command ?? '')
    const matched = Object.keys(ASK_SHELL).filter((key) => ASK_SHELL[key].test(command))
    return matched.some((key) => !free.includes(`bash:${key}`)) ? 'ask' : 'allow'
  }
  if (ask.includes(name)) return 'ask'
  if (free.includes(name)) return 'allow'
  if (FILE_WRITE_TOOLS.has(call.tool)) {
    const path = call.input.file_path ?? call.input.notebook_path
    const rel = typeof path === 'string' ? inFolder(ctx.folder, path) : null
    return rel !== null && isBotWritable(rel) ? 'allow' : 'ask'
  }
  // Only trek-dev tools count: another server's tool of the same name is unknown.
  const isOtherMcp = call.tool.startsWith('mcp__') && !call.tool.startsWith(TREK_PREFIX)
  return !isOtherMcp && FREE_TOOLS.has(name) ? 'allow' : 'ask'
}

export function decide(call: ToolCall, ctx: PolicyContext): PolicyDecision {
  const never = neverReason(call, ctx)
  if (never) return { decision: 'deny', reason: never }
  const approved = ctx.approvals.find((a) => a.status === 'approved' && approvalMatches(a, call))
  if (approved) return { decision: 'allow', reason: 'Approved by the user', approvalId: approved.id }
  return tierOf(call, ctx) === 'allow'
    ? { decision: 'allow', reason: 'Allowed by policy' }
    : { decision: 'ask', reason: askReason(call) }
}
