import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Approval, ToolCall } from '../../shared/bot'
import { analyzeShell, couldMatch, expandPath } from './shellCommand.ts'

export interface PolicyOverrides {
  /** Tool names without the MCP prefix, or `bash:<key>` with a key from shellCommand's analysis. */
  free?: string[]
  ask?: string[]
}

export interface PolicyContext {
  folder: string
  /** The bot's working directory. Defaults to `folder`. */
  cwd?: string
  /**
   * Files no tool may read or write. A `*` in a file name stands for any run of characters.
   * Each one's copies (`<name>.<anything>`, such as atomic-write temp files) are secret too.
   */
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
  'Read', 'Glob', 'Grep', 'LS', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList',
  'list_worktrees', 'get_selected_worktree', 'list_session_types',
  'start_session', 'send_prompt', 'enqueue_prompt', 'remove_queued_prompt',
  'read_terminal', 'wait_for_sessions', 'create_worktree', 'load_worktree',
  'get_stack', 'start_stack', 'stop_stack', 'read_stack_log',
  'set_worktree_tag', 'set_worktree_custom_tag', 'set_worktree_note',
  'set_worktree_ticket', 'set_worktree_pull_request', 'request_approval'
])

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'REPL'])

const FORCE_PUSH_REASON = 'Force-pushing is never allowed.'
const PROTECTED_REASON = 'Protected bot files cannot be changed.'
const SECRET_REASON = "Trek's secret stores cannot be read."

const FOLDS_CASE = process.platform === 'darwin' || process.platform === 'win32'
const fold = (path: string): string => (FOLDS_CASE ? path.toLowerCase() : path)

/** Expands `~`, resolves against cwd, and folds case where the filesystem does. */
const normalizePath = (path: string, cwd: string): string => fold(expandPath(path, cwd))

const PROTECTED = ['BOT.md', 'POLICY.json', 'config.json', 'state'].map(fold)
const STATE_DIR = `${fold('state')}${sep}`
const BOT_WRITABLE_FILES = ['HEARTBEAT.md', 'MEMORY.md'].map(fold)
const BOT_WRITABLE_DIRS = ['knowledge', 'journal'].map((dir) => `${fold(dir)}${sep}`)

/** `path` resolved (see expandPath) with symlinks followed as far as it exists; the rest as written. Case not folded. */
function physicalPath(path: string, cwd: string): string {
  const full = expandPath(path, cwd)
  const tail: string[] = []
  for (let head = full; ; head = dirname(head)) {
    try {
      return join(realpathSync.native(head), ...tail)
    } catch {
      if (dirname(head) === head) return full
      tail.unshift(basename(head))
    }
  }
}

/** A secret file: its folded, physical directory, and a test for its name or a copy's (folded). */
interface SecretFile {
  dir: string
  name: RegExp
  /** Concrete names it and its copies take, for telling whether a shell glob could reach one */
  samples: string[]
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Copies writers make beside a file: writeFileAtomic's `<name>.<pid>.tmp`, and a corrupt file set aside. */
const COPY_SUFFIXES = ['', `.${process.pid}.tmp`, `.corrupt-${Date.now()}`]
/** What `*` in a secret's name stands for in samples: window ids, short and long. */
const STAR_SAMPLES = ['1', '12', '123', '1234', '12345']

function secretFile(path: string, cwd: string): SecretFile {
  const full = fold(physicalPath(path, cwd))
  const base = basename(full)
  const stems = base.includes('*') ? STAR_SAMPLES.map((n) => base.replaceAll('*', n)) : [base]
  return {
    dir: dirname(full),
    name: new RegExp(`^${base.split('*').map(escapeRegExp).join('[^/\\\\]*')}(?:\\..*)?$`, 's'),
    samples: stems.flatMap((stem) => COPY_SUFFIXES.map((suffix) => stem + suffix))
  }
}

/** `path` (folded, physical) is a secret file or one of its copies. */
const isSecretFile = (path: string, secrets: SecretFile[]): boolean =>
  secrets.some((s) => dirname(path) === s.dir && s.name.test(basename(path)))

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  )

/** Bash matches on the command and sandbox alone: the model rewrites `description` freely. */
function callKey(tool: string, input: Record<string, unknown>): string {
  if (tool !== 'Bash') return `${tool}:${stable(input)}`
  return `Bash:${stable({ command: input?.command, dangerouslyDisableSandbox: input?.dangerouslyDisableSandbox === true || undefined })}`
}

export function approvalMatches(approval: Approval, call: ToolCall): boolean {
  return callKey(approval.tool, approval.input) === callKey(call.tool, call.input)
}

const cwdOf = (ctx: PolicyContext): string => expandPath(ctx.cwd ?? ctx.folder, ctx.folder)
const folderOf = (ctx: PolicyContext): string => normalizePath(ctx.folder, cwdOf(ctx))

/** The path below `dir`, or null when it is `dir` itself or outside it. Both are normalised. */
function within(dir: string, path: string): string | null {
  const rel = relative(dir, path)
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel
}

/** The directory and each one above it, up to the root. */
function ancestorsOf(dir: string): string[] {
  const parent = dirname(dir)
  return parent === dir ? [dir] : [dir, ...ancestorsOf(parent)]
}

const isProtected = (rel: string): boolean => PROTECTED.includes(rel) || rel.startsWith(STATE_DIR)

const isBotWritable = (rel: string): boolean =>
  BOT_WRITABLE_FILES.includes(rel) || BOT_WRITABLE_DIRS.some((dir) => rel.startsWith(dir))

/** The path a file tool acts on, chosen by tool so a decoy key can't stand in. */
function filePath(call: ToolCall): string | null {
  const path = call.tool === 'NotebookEdit' ? call.input.notebook_path : call.input.file_path
  return typeof path === 'string' ? path : null
}

function fileToolNever(call: ToolCall, ctx: PolicyContext, secrets: SecretFile[]): string | null {
  const cwd = cwdOf(ctx)
  if (call.tool === 'Grep') {
    const target = fold(physicalPath(typeof call.input.path === 'string' ? call.input.path : '.', cwd))
    const reaches = isSecretFile(target, secrets) || secrets.some((s) => s.dir === target || within(target, s.dir) !== null)
    return reaches ? SECRET_REASON : null
  }
  const raw = filePath(call)
  if (raw === null) return null
  const path = normalizePath(raw, cwd)
  const writes = FILE_WRITE_TOOLS.has(call.tool)
  if ((writes || call.tool === 'Read') && isSecretFile(fold(physicalPath(raw, cwd)), secrets)) return SECRET_REASON
  const rel = within(folderOf(ctx), path)
  return writes && rel !== null && isProtected(rel) ? PROTECTED_REASON : null
}

function shellNever(command: string, ctx: PolicyContext, secrets: SecretFile[]): string | null {
  const shell = analyzeShell(command, cwdOf(ctx))
  if (shell.forcePush) return FORCE_PUSH_REASON
  const folder = folderOf(ctx)
  const protectedFiles = PROTECTED.map((name) => join(folder, name))
  const hitsProtected = (ref: string): boolean => {
    const rel = within(folder, ref)
    return (rel !== null && isProtected(rel)) || protectedFiles.some((file) => couldMatch(ref, file))
  }
  if (shell.writes.map(fold).some(hitsProtected)) return PROTECTED_REASON
  const folderAndAncestors = ancestorsOf(folder)
  const destroysFolder = (ref: string): boolean => folderAndAncestors.some((dir) => couldMatch(ref, dir))
  if (shell.destroys.map(fold).some(destroysFolder)) return PROTECTED_REASON
  // A path that is a secret or its directory, or a glob that could match either (or a copy).
  const secretTargets = [...new Set(secrets.flatMap((s) => [s.dir, ...s.samples.map((name) => join(s.dir, name))]))]
  const reachesSecret = (ref: string): boolean => {
    const path = fold(physicalPath(ref, cwdOf(ctx)))
    return isSecretFile(path, secrets) || secretTargets.some((target) => couldMatch(path, target))
  }
  return shell.paths.some(reachesSecret) ? SECRET_REASON : null
}

function neverReason(call: ToolCall, ctx: PolicyContext): string | null {
  const secrets = ctx.secretPaths.map((p) => secretFile(p, cwdOf(ctx)))
  if (!SHELL_TOOLS.has(call.tool)) return fileToolNever(call, ctx, secrets)
  return typeof call.input.command === 'string' ? shellNever(call.input.command, ctx, secrets) : null
}

function askReason(call: ToolCall): string {
  return `Needs approval. Call ${TREK_PREFIX}request_approval with tool "${call.tool}", this exact input and a reason, then end your turn. The result arrives in a later turn.`
}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function tierOf(call: ToolCall, ctx: PolicyContext): 'allow' | 'ask' {
  const name = call.tool.startsWith(TREK_PREFIX) ? call.tool.slice(TREK_PREFIX.length) : call.tool
  const free = stringsOf(ctx.overrides?.free)
  const ask = stringsOf(ctx.overrides?.ask)
  if (call.tool === 'Bash') {
    const command = call.input.command
    if (ask.includes('Bash') || typeof command !== 'string') return 'ask'
    const keys = analyzeShell(command, cwdOf(ctx)).ask.map((key) => `bash:${key}`)
    return keys.some((key) => !free.includes(key) || ask.includes(key)) ? 'ask' : 'allow'
  }
  if (ask.includes(name)) return 'ask'
  if (free.includes(name)) return 'allow'
  if (FILE_WRITE_TOOLS.has(call.tool)) {
    const path = filePath(call)
    const rel = path === null ? null : within(folderOf(ctx), normalizePath(path, cwdOf(ctx)))
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
