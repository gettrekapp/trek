import {
  allWorktrees,
  branchCustomTags,
  branchTag,
  dormantSessions,
  GLOBAL_WORKTREE_ID,
  hostRepoPath,
  instanceForInfo,
  mergedWorktrees,
  parseTicket,
  repoById,
  repoHostKey,
  repoOfInfo,
  repoOfWorktreeId,
  serverById,
  ticketUrl,
  useAppStore
} from './store'
import {
  createTerminal,
  disposeTerminal,
  loadWorktree,
  pasteToTerminal,
  readTerminal,
  requestTerminalDecision,
  sendKeysToTerminal,
  startClaudeSession,
  unloadWorktree
} from './terminals'
import { isProviderId, PROVIDER_LIST } from '../../shared/providers/registry'
import { sanitizeLlmSelection } from '../../shared/providers/selection'
import type { LlmSelection } from '../../shared/providers/types'
import { createBranchWorktree, promoteToPrimary } from './worktreeActions'
import { scheduleAutoSave } from './persistence'
import { stackState, stackUrls, stripAnsi } from './stacks'
import { MAX_SUMMARY_CHARS, speakSummary, voiceReady } from './voice'
import { ambiguousAcrossRepos, findRepository } from '../../shared/repositories'
import { sameWorktree } from '../../shared/types'
import type {
  GitWorktreeInfo,
  McpCallRequest,
  Repository,
  SessionType,
  StackStatus,
  TerminalStatus,
  WorktreeInstance,
  WorktreeLocator
} from '../../shared/types'

/**
 * Executes the MCP server's tool calls (src/main/mcp.ts) against the live
 * app state, so the global Claude session can drive worktree sessions.
 */

const BUSY: TerminalStatus[] = ['starting', 'working']
const DEFAULT_WAIT_S = 300
const MAX_WAIT_S = 600
/** After a prompt is sent, output can take a moment to flip a session to working. */
const WAIT_GRACE_MS = 1500

class ToolError extends Error {}

function project(): NonNullable<ReturnType<typeof useAppStore.getState>['project']> {
  const p = useAppStore.getState().project
  if (!p) throw new ToolError('No project is open')
  return p
}

interface ResolvedWorktree {
  loc: WorktreeLocator
  info?: GitWorktreeInfo
  instance?: WorktreeInstance
}

function instanceFor(info: GitWorktreeInfo): WorktreeInstance | undefined {
  return instanceForInfo(project(), info)
}

function resolveWorktree(ref: unknown): ResolvedWorktree {
  if (typeof ref !== 'string' || !ref.trim()) throw new ToolError('worktree is required')
  const p = project()
  const infos = mergedWorktrees(p, useAppStore.getState().hostWorktrees)
  const instance = allWorktrees(p).find((w) => w.id === ref)
  if (instance) {
    const info = infos.find((i) => instanceFor(i)?.id === instance.id)
    return { loc: { serverId: instance.serverId, path: instance.path }, info, instance }
  }
  const pathMatch = infos.find((i) => i.path === ref)
  const branchMatches = infos.filter((i) => i.branch === ref)
  const nameMatches = infos.filter((i) => instanceFor(i)?.name === ref)
  // A branch in one repository and a name in another is just as ambiguous.
  const matches = [...new Set([...branchMatches, ...nameMatches])]
  if (!pathMatch && ambiguousAcrossRepos(matches)) {
    const listed = matches.map((i) => `${repoOfInfo(p, i).name}: ${i.path}`).join(', ')
    throw new ToolError(`"${ref}" matches more than one repository (${listed}) — pass the path`)
  }
  const info = pathMatch ?? branchMatches[0] ?? nameMatches[0]
  if (!info) throw new ToolError(`No worktree matches "${ref}" — call list_worktrees`)
  return { loc: { serverId: info.serverId, path: info.path }, info, instance: instanceFor(info) }
}

function requireTerminal(ref: unknown): string {
  const state = useAppStore.getState()
  const meta = typeof ref === 'string' ? state.terminals[ref] : undefined
  if (!meta || meta.worktreeId === GLOBAL_WORKTREE_ID) {
    throw new ToolError(`No session with terminalId "${String(ref)}" — call list_worktrees`)
  }
  return meta.id
}

function sessionsOf(
  worktreeId: string
): {
  terminalId: string
  title: string
  status: TerminalStatus
  llm: LlmSelection
  decision: string | null
  active: boolean
  queue: string[]
}[] {
  const state = useAppStore.getState()
  return (state.terminalOrder[worktreeId] ?? [])
    .map((id) => state.terminals[id])
    .filter(Boolean)
    .map((t) => ({
      terminalId: t.id,
      title: t.title,
      status: t.status,
      // Sessions from before providers existed are Claude.
      llm: t.llm ?? { provider: 'claude' },
      decision: state.decisions[t.id]?.question ?? null,
      active: state.activeTerminal[worktreeId] === t.id,
      queue: state.terminalQueues[t.id] ?? []
    }))
}

function queueOf(id: string): string[] {
  return useAppStore.getState().terminalQueues[id] ?? []
}

function describeWorktree(info: GitWorktreeInfo): Record<string, unknown> {
  const p = project()
  const state = useAppStore.getState()
  const repo = repoOfInfo(p, info)
  const instance = instanceFor(info)
  const branch = info.branch
  const ticket = (branch && repo.branchTickets?.[branch]) || null
  const issue = ticket ? state.linearIssues[ticket] : undefined
  return {
    worktree: instance?.id ?? info.path,
    repo: repo.name,
    path: info.path,
    server: info.serverId ? (serverById(p, info.serverId)?.name ?? info.serverId) : 'local',
    branch: branch ?? null,
    primary: info.isMain && !info.serverId,
    selected: isSelected(info),
    tag: branchTag(p, repo, branch)?.name ?? null,
    customTags: branchCustomTags(p, repo, branch).map((t) => t.name),
    ticket,
    ticketTitle: issue?.title ?? null,
    ticketStatus: issue?.status ?? null,
    pullRequest: (branch && repo.branchPullRequests?.[branch]) || null,
    note: (branch && repo.branchNotes?.[branch]) || null,
    dirty: info.dirty ?? null,
    ahead: info.ahead ?? null,
    behind: info.behind ?? null,
    loaded: !!instance && !!state.loadedWorktrees[instance.id],
    savedSessions: instance ? dormantSessions(state, instance.id).length : 0,
    sessions: instance ? sessionsOf(instance.id) : []
  }
}

function isSelected(info: GitWorktreeInfo): boolean {
  const { selected, activeWorktreeId } = useAppStore.getState()
  // The primary is selected by instance id: git's resolved path can differ
  // from the stored one.
  if (activeWorktreeId) return instanceFor(info)?.id === activeWorktreeId
  return !!selected && sameWorktree(selected, info)
}

function allInfos(): GitWorktreeInfo[] {
  return mergedWorktrees(project(), useAppStore.getState().hostWorktrees)
}

function currentSession(args: Record<string, unknown>): unknown {
  const id = requireTerminal(args.terminalId)
  const meta = useAppStore.getState().terminals[id]
  const info = allInfos().find((i) => instanceFor(i)?.id === meta.worktreeId)
  if (!info) throw new ToolError('The session\'s worktree is no longer in the project')
  return {
    terminalId: id,
    title: meta.title,
    status: meta.status,
    llm: meta.llm ?? { provider: 'claude' },
    queue: queueOf(id),
    worktree: describeWorktree(info)
  }
}

async function promote(args: Record<string, unknown>): Promise<unknown> {
  const { info, instance } = resolveWorktree(args.worktree)
  if (!info) throw new ToolError('That worktree is not in the current git worktree list')
  if (info.serverId) throw new ToolError('Only local worktrees can be promoted')
  if (info.isMain) throw new ToolError('That worktree is already the primary checkout')
  const promoted = await promoteToPrimary(info, instance)
  if (!promoted) {
    throw new ToolError('Not promoted — the user cancelled, or git refused (the app showed why)')
  }
  // The main checkout's branch changed; re-read it rather than wait for the poll.
  const repo = repoOfInfo(project(), info)
  const fresh = (await window.api.listWorktrees(null, repo.path)).map((i) => ({
    ...i,
    repoId: repo.id
  }))
  useAppStore.getState().setHostWorktrees(repoHostKey(repo.id), fresh)
  const primary = allInfos().find((i) => i.isMain && !i.serverId && i.repoId === repo.id)
  return primary ? describeWorktree(primary) : { promoted: true }
}

/** The repository a create_worktree call targets. Required once a project has several. */
function targetRepository(ref: unknown): Repository {
  const repositories = project().repositories
  const name = typeof ref === 'string' ? ref.trim() : ''
  const valid = repositories.map((r) => r.name).join(', ')
  if (!name) {
    if (repositories.length === 1) return repositories[0]
    throw new ToolError(`repo is required in this project. Repositories: ${valid}`)
  }
  const found = findRepository(repositories, name)
  if (found === 'ambiguous') {
    throw new ToolError(`"${name}" matches more than one repository. Use its id.`)
  }
  if (!found) throw new ToolError(`Unknown repo "${name}". Repositories: ${valid}`)
  return found
}

async function createWorktree(args: Record<string, unknown>): Promise<unknown> {
  const branch = typeof args.branch === 'string' ? args.branch.trim() : ''
  if (!branch) throw new ToolError('branch is required')
  const p = project()
  const repo = targetRepository(args.repo)
  const state = useAppStore.getState()
  const serverRef = typeof args.server === 'string' ? args.server.trim() : ''
  let serverId: string | undefined
  if (serverRef && serverRef !== 'local') {
    const server = (p.servers ?? []).find(
      (s) => s.id === serverRef || s.name.toLowerCase() === serverRef.toLowerCase()
    )
    if (!server) {
      const valid = (p.servers ?? []).map((s) => s.name).join(', ') || 'none configured'
      throw new ToolError(`Unknown server "${serverRef}". Servers: ${valid}`)
    }
    if (state.serverStatus[server.id] !== 'connected') {
      throw new ToolError(`Server "${server.name}" is not connected`)
    }
    serverId = server.id
  }
  const repoPath = hostRepoPath(repo, serverId)
  if (!repoPath) throw new ToolError(`${repo.name} has no repository path on that server`)
  const checkedOut = allInfos().find(
    (i) => i.branch === branch && i.serverId === serverId && i.repoId === repo.id
  )
  if (checkedOut) {
    throw new ToolError(`"${branch}" is already checked out at ${checkedOut.path}`)
  }

  const path = await createBranchWorktree(
    repo.id,
    serverId,
    repoPath,
    branch,
    args.existingBranch !== true
  )
  const instance: WorktreeInstance = { id: crypto.randomUUID(), name: branch, path, serverId, branch }
  // Adding an instance selects it; don't yank the user's view.
  const { selected, activeWorktreeId } = useAppStore.getState()
  useAppStore.getState().addWorktreeInstance(repo.id, instance)
  useAppStore.setState({ selected, activeWorktreeId })
  scheduleAutoSave()

  // Re-read the host's worktrees rather than wait for the poll.
  const fresh = (await window.api.listWorktrees(serverId ?? null, repoPath)).map((info) => ({
    ...info,
    serverId,
    repoId: repo.id
  }))
  useAppStore.getState().setHostWorktrees(repoHostKey(repo.id, serverId), fresh)
  const info = allInfos().find((i) => instanceFor(i)?.id === instance.id)
  return info ? describeWorktree(info) : { worktree: instance.id, repo: repo.name, path, branch }
}

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i

function pullRequestUrl(input: string, repoId: string): string {
  const url = input.match(PR_URL)
  if (url) return `https://github.com/${url[1]}/${url[2]}/pull/${url[3]}`
  const num = input.match(/^#?(\d+)$/)
  if (!num) {
    throw new ToolError(`Unrecognised pull request "${input}". Use its GitHub URL or number.`)
  }
  const known = Object.values(repoById(project(), repoId)?.branchPullRequests ?? {})
    .map((u) => u.match(PR_URL))
    .find(Boolean)
  if (!known) {
    throw new ToolError('No other PR is linked to infer the repo from — pass the full GitHub URL')
  }
  return `https://github.com/${known[1]}/${known[2]}/pull/${num[1]}`
}

function statusOf(id: string): TerminalStatus | 'closed' {
  return useAppStore.getState().terminals[id]?.status ?? 'closed'
}

const settled = (id: string): boolean => !BUSY.includes(statusOf(id) as TerminalStatus)

/** Resolves once `done(ids)` holds, or the timeout passes. */
function waitFor(ids: string[], done: (ids: string[]) => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (done(ids)) return resolve(true)
    const timer = setTimeout(() => {
      unsubscribe()
      resolve(false)
    }, timeoutMs)
    const unsubscribe = useAppStore.subscribe(() => {
      if (!done(ids)) return
      clearTimeout(timer)
      unsubscribe()
      resolve(true)
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A just-started session must finish booting before it can take input. */
async function waitUntilReady(id: string): Promise<void> {
  if (statusOf(id) !== 'starting') return
  await waitFor([id], (ids) => statusOf(ids[0]) !== 'starting', 60_000)
  await waitFor([id], (ids) => settled(ids[0]), 30_000)
}

function sessionTypes(): SessionType[] {
  return project().sessionTypes ?? []
}

function findSessionType(ref: string): SessionType | undefined {
  const name = ref.trim().toLowerCase()
  return sessionTypes().find((t) => t.id === ref || t.name.trim().toLowerCase() === name)
}

function requireSessionType(ref: unknown): SessionType {
  if (typeof ref !== 'string' || !ref.trim()) throw new ToolError('sessionType is required')
  const type = findSessionType(ref)
  if (!type) {
    const names = sessionTypes().map((t) => t.name).join(', ') || 'none configured'
    throw new ToolError(`No session type matches "${ref}". Session types: ${names}`)
  }
  return type
}

function setSessionTypes(types: SessionType[]): void {
  useAppStore.getState().setSessionTypes(types)
  scheduleAutoSave()
}

/** Session types as tools return them — the icon data URL is just noise to Claude. */
function withoutIcon(type: SessionType): Omit<SessionType, 'icon'> {
  const { icon: _icon, ...rest } = type
  return rest
}

/** A { provider, model?, effort? } argument; `required` when the caller passed an llm object. */
function llmArg(args: Record<string, unknown>, required = false): LlmSelection | undefined {
  if (args.provider === undefined || args.provider === '') {
    if (required) throw new ToolError('llm needs a provider')
    if ((args.model !== undefined && args.model !== '') || (args.effort !== undefined && args.effort !== '')) {
      throw new ToolError('model and effort need a provider')
    }
    return undefined
  }
  if (!isProviderId(args.provider)) {
    throw new ToolError(
      `Unknown provider "${String(args.provider)}". Use one of: ${PROVIDER_LIST.map((p) => p.id).join(', ')}`
    )
  }
  return sanitizeLlmSelection({ provider: args.provider, model: args.model, effort: args.effort })
}

function saveSessionType(args: Record<string, unknown>): SessionType {
  const name = typeof args.name === 'string' ? args.name.trim() : undefined
  const systemPrompt = typeof args.systemPrompt === 'string' ? args.systemPrompt : undefined
  const initialMessage = typeof args.initialMessage === 'string' ? args.initialMessage : undefined
  if (args.llm !== undefined && args.llm !== null && (typeof args.llm !== 'object' || Array.isArray(args.llm))) {
    throw new ToolError('llm must be an object { provider, model?, effort? } or null')
  }
  const llm =
    args.llm === null ? null : args.llm === undefined ? undefined : llmArg(args.llm as Record<string, unknown>, true)
  let existing: SessionType | undefined
  if (typeof args.id === 'string' && args.id) {
    existing = sessionTypes().find((t) => t.id === args.id)
    if (!existing) throw new ToolError(`No session type with id "${args.id}"`)
  } else if (name) {
    existing = findSessionType(name)
  }
  if (existing) {
    const updated = {
      ...existing,
      ...(name ? { name } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(initialMessage !== undefined ? { initialMessage } : {}),
      ...(llm === null ? { llm: undefined } : llm ? { llm } : {})
    }
    setSessionTypes(sessionTypes().map((t) => (t.id === existing.id ? updated : t)))
    return withoutIcon(updated)
  }
  if (!name) throw new ToolError('name is required to create a session type')
  const created = {
    id: crypto.randomUUID(),
    name,
    systemPrompt: systemPrompt ?? '',
    ...(initialMessage !== undefined ? { initialMessage } : {}),
    ...(llm ? { llm } : {})
  }
  setSessionTypes([...sessionTypes(), created])
  return created
}

async function startSession(args: Record<string, unknown>): Promise<unknown> {
  const { loc, instance } = resolveWorktree(args.worktree)
  const sessionType =
    args.sessionType === undefined || args.sessionType === ''
      ? undefined
      : requireSessionType(args.sessionType)
  const llm = llmArg(args)
  const before = useAppStore.getState()
  const id = instance
    ? await createTerminal(instance.id, instance.path, undefined, sessionType, llm)
    : await startClaudeSession(loc, sessionType, llm)
  if (!id) throw new ToolError('Could not start a session')
  // Creating a worktree instance selects it; don't yank the user's view.
  const after = useAppStore.getState()
  if (after.activeWorktreeId !== before.activeWorktreeId && after.selected && sameWorktree(after.selected, loc)) {
    useAppStore.setState({ selected: before.selected, activeWorktreeId: before.activeWorktreeId })
  }
  if (typeof args.prompt === 'string' && args.prompt.trim()) {
    await waitUntilReady(id)
    pasteToTerminal(id, args.prompt, false)
  }
  return { terminalId: id, status: statusOf(id) }
}

async function sendPrompt(args: Record<string, unknown>): Promise<unknown> {
  const id = requireTerminal(args.terminalId)
  if (typeof args.text !== 'string' || !args.text.trim()) throw new ToolError('text is required')
  if (statusOf(id) === 'exited') throw new ToolError('That session has exited')
  await waitUntilReady(id)
  pasteToTerminal(id, args.text, false)
  return { sent: true }
}

async function waitForSessions(args: Record<string, unknown>): Promise<unknown> {
  const ids = Array.isArray(args.terminalIds) ? args.terminalIds.map(String) : []
  if (ids.length === 0) throw new ToolError('terminalIds is required')
  ids.forEach(requireTerminal)
  const any = args.until === 'any'
  const seconds = Math.min(Number(args.timeoutSeconds) || DEFAULT_WAIT_S, MAX_WAIT_S)
  const done = (list: string[]): boolean => (any ? list.some(settled) : list.every(settled))
  // A prompt sent a moment ago may not have produced output yet — don't
  // report its still-idle status as finished.
  if (done(ids)) await sleep(WAIT_GRACE_MS)
  const completed = await waitFor(ids, done, seconds * 1000)
  return {
    timedOut: !completed,
    sessions: ids.map((id) => ({ terminalId: id, status: statusOf(id) }))
  }
}

function branchOf(args: Record<string, unknown>): { repoId: string; branch: string } {
  const { info, instance } = resolveWorktree(args.worktree)
  const branch = info?.branch ?? instance?.branch
  if (!branch) throw new ToolError('That worktree has no branch (detached HEAD)')
  const repo = info
    ? repoOfInfo(project(), info)
    : instance && repoOfWorktreeId(project(), instance.id)
  if (!repo) throw new ToolError('That worktree is no longer in the project')
  return { repoId: repo.id, branch }
}

function describeStack(status: StackStatus): Record<string, unknown> {
  return {
    name: status.slug ? `trek-${status.slug}` : null,
    state: stackState(status),
    containers: status.containers,
    ports: status.port ? { first: status.port, last: status.port + 5 } : null,
    urls: Object.fromEntries(stackUrls(status).map((u) => [u.label, u.url])),
    logins: 'admin or bill, password sample123'
  }
}

async function stackTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { loc } = resolveWorktree(args.worktree)
  if (loc.serverId) throw new ToolError('Dev stacks run only for local worktrees')
  const path = loc.path
  const status = await window.api.stackStatus(path)
  if (!status.available) {
    if (name === 'get_stack') return { available: false }
    throw new ToolError('That worktree has no docker/stack/stack.sh')
  }
  switch (name) {
    case 'start_stack':
      if (stackState(status) !== 'stopped') {
        throw new ToolError(`The stack is already ${stackState(status)}`)
      }
      await window.api.stackUp(path, args.starter === true)
      return describeStack(await window.api.stackStatus(path))
    case 'stop_stack': {
      const code = await window.api.stackDown(path)
      if (code !== 0) throw new ToolError(`stack.sh down exited with code ${code} — see read_stack_log`)
      return describeStack(await window.api.stackStatus(path))
    }
    case 'read_stack_log': {
      const lines = Math.min(Math.max(Number(args.lines) || 100, 1), 2000)
      const { text } = await window.api.stackLog(path, 0, 0)
      return { output: stripAnsi(text).split('\n').slice(-lines).join('\n') }
    }
    default:
      return { available: true, ...describeStack(status) }
  }
}

async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'bot_snapshot': {
      const { terminals, decisions } = useAppStore.getState()
      return {
        worktrees: allInfos().map((info) => ({
          path: info.path,
          branch: info.branch ?? null,
          head: info.head ?? null
        })),
        sessions: Object.entries(terminals)
          .filter(([, meta]) => meta.worktreeId !== GLOBAL_WORKTREE_ID)
          .map(([id, meta]) => ({
            id,
            worktreeId: meta.worktreeId,
            title: meta.title,
            status: meta.status,
            decision: !!decisions[id]
          }))
      }
    }
    case 'list_worktrees':
      return allInfos().map(describeWorktree)
    case 'get_selected_worktree': {
      const info = allInfos().find(isSelected)
      if (!info) throw new ToolError('No worktree is selected')
      return describeWorktree(info)
    }
    case 'get_current_session':
      return currentSession(args)
    case 'request_decision': {
      // Global sessions may ask too, so this doesn't go through requireTerminal.
      const id = typeof args.terminalId === 'string' ? args.terminalId : ''
      if (!useAppStore.getState().terminals[id]) {
        throw new ToolError(`No session with terminalId "${id}" — pass $TREK_TERMINAL_ID`)
      }
      const question = typeof args.question === 'string' ? args.question.trim() : ''
      if (!question) throw new ToolError('question is required')
      requestTerminalDecision(id, question)
      return { notified: true }
    }
    case 'speak_summary': {
      const id = typeof args.terminalId === 'string' ? args.terminalId : ''
      if (!useAppStore.getState().terminals[id]) {
        throw new ToolError(`No session with terminalId "${id}" — pass $TREK_TERMINAL_ID`)
      }
      const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
      if (!summary) throw new ToolError('summary is required')
      if (summary.length > MAX_SUMMARY_CHARS) {
        throw new ToolError(
          `The summary is ${summary.length} characters; keep it to one to three short sentences (at most ${MAX_SUMMARY_CHARS}) and call again`
        )
      }
      if (!voiceReady()) {
        return {
          played: false,
          reason: 'Voice summaries are not set up in this app — do not call speak_summary again'
        }
      }
      return speakSummary(id, summary)
    }
    case 'create_worktree':
      return createWorktree(args)
    case 'promote_to_primary':
      return promote(args)
    case 'start_session':
      return startSession(args)
    case 'list_session_types':
      return sessionTypes().map(withoutIcon)
    case 'save_session_type':
      return saveSessionType(args)
    case 'delete_session_type': {
      const type = requireSessionType(args.sessionType)
      setSessionTypes(sessionTypes().filter((t) => t.id !== type.id))
      return { deleted: type.name }
    }
    case 'load_worktree': {
      const { instance } = resolveWorktree(args.worktree)
      if (!instance) return { loaded: false, reason: 'No saved sessions — use start_session' }
      await loadWorktree(instance.id)
      return { loaded: true, sessions: sessionsOf(instance.id) }
    }
    case 'unload_worktree': {
      const { instance } = resolveWorktree(args.worktree)
      if (instance) unloadWorktree(instance.id)
      return { unloaded: true }
    }
    case 'send_prompt':
      return sendPrompt(args)
    case 'send_keys': {
      const id = requireTerminal(args.terminalId)
      const keys = Array.isArray(args.keys) ? args.keys.map(String) : []
      if (keys.length === 0) throw new ToolError('keys is required')
      sendKeysToTerminal(id, keys)
      return { sent: keys.length }
    }
    case 'read_terminal': {
      const id = requireTerminal(args.terminalId)
      const lines = Math.min(Math.max(Number(args.lines) || 80, 1), 2000)
      return { status: statusOf(id), output: readTerminal(id, lines) ?? '' }
    }
    case 'wait_for_sessions':
      return waitForSessions(args)
    case 'focus_session': {
      const id = requireTerminal(args.terminalId)
      const { worktreeId } = useAppStore.getState().terminals[id]
      useAppStore.getState().setActiveWorktree(worktreeId)
      useAppStore.getState().setActiveTerminal(worktreeId, id)
      return { focused: true }
    }
    case 'close_session':
      disposeTerminal(requireTerminal(args.terminalId))
      return { closed: true }
    case 'enqueue_prompt': {
      const id = requireTerminal(args.terminalId)
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (!text) throw new ToolError('text is required')
      useAppStore.getState().enqueueTerminalText(id, text)
      scheduleAutoSave() // queues persist in the project file
      return { queue: queueOf(id) }
    }
    case 'remove_queued_prompt': {
      const id = requireTerminal(args.terminalId)
      const queue = queueOf(id)
      const index = Number(args.index)
      if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
        throw new ToolError(
          queue.length
            ? `index must be 0–${queue.length - 1}; the queue has ${queue.length} prompt(s)`
            : 'The queue is empty'
        )
      }
      useAppStore.getState().removeQueuedText(id, index)
      scheduleAutoSave()
      return { removed: queue[index], queue: queueOf(id) }
    }
    case 'set_worktree_tag': {
      const { repoId, branch } = branchOf(args)
      const name = typeof args.tag === 'string' ? args.tag.trim() : ''
      const tags = project().worktreeTags ?? []
      const tag = name ? tags.find((t) => t.name.toLowerCase() === name.toLowerCase()) : null
      if (tag === undefined) {
        const valid = tags.map((t) => t.name).join(', ') || 'none configured'
        throw new ToolError(`Unknown tag "${name}". Valid tags: ${valid}`)
      }
      useAppStore.getState().setBranchTag(repoId, branch, tag?.id ?? null)
      scheduleAutoSave()
      return { branch, tag: tag?.name ?? null }
    }
    case 'set_worktree_custom_tag': {
      const { repoId, branch } = branchOf(args)
      const name = typeof args.tag === 'string' ? args.tag.trim() : ''
      const tags = project().customTags ?? []
      const tag = tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
      if (!tag) {
        const valid = tags.map((t) => t.name).join(', ') || 'none configured'
        throw new ToolError(`Unknown custom tag "${name}". Valid custom tags: ${valid}`)
      }
      useAppStore.getState().setBranchCustomTag(repoId, branch, tag.id, args.enabled !== false)
      scheduleAutoSave()
      return {
        branch,
        customTags: branchCustomTags(project(), repoById(project(), repoId)!, branch).map((t) => t.name)
      }
    }
    case 'set_worktree_note': {
      const { repoId, branch } = branchOf(args)
      useAppStore.getState().setBranchNote(repoId, branch, typeof args.note === 'string' ? args.note : '')
      scheduleAutoSave()
      return { branch }
    }
    case 'set_worktree_ticket': {
      const { repoId, branch } = branchOf(args)
      const store = useAppStore.getState()
      const input = typeof args.ticket === 'string' ? args.ticket.trim() : ''
      if (!input) {
        store.setBranchTicket(repoId, branch, null)
        scheduleAutoSave()
        return { branch, ticket: null }
      }
      const parsed = parseTicket(input)
      if (!parsed) {
        throw new ToolError(
          `Unrecognised ticket "${input}". Use a Linear issue id (TOW-123), a Linear issue URL, or an Azure DevOps work item id/URL.`
        )
      }
      if (parsed.linearWorkspace) store.setLinearWorkspace(parsed.linearWorkspace)
      if (parsed.azureDevOpsBaseUrl) store.setAzureDevOpsBaseUrl(parsed.azureDevOpsBaseUrl)
      store.setBranchTicket(repoId, branch, parsed.ticketId)
      scheduleAutoSave()
      const project = useAppStore.getState().project!
      return { branch, ticket: parsed.ticketId, url: ticketUrl(project, parsed.ticketId) }
    }
    case 'set_worktree_pull_request': {
      const { repoId, branch } = branchOf(args)
      const input = typeof args.pullRequest === 'string' ? args.pullRequest.trim() : ''
      const url = input ? pullRequestUrl(input, repoId) : null
      useAppStore.getState().setBranchPullRequest(repoId, branch, url)
      scheduleAutoSave()
      return { branch, pullRequest: url }
    }
    case 'get_stack':
    case 'start_stack':
    case 'stop_stack':
    case 'read_stack_log':
      return stackTool(name, args)
    default:
      throw new ToolError(`Unknown tool: ${name}`)
  }
}

export async function handleMcpCall({ callId, name, args }: McpCallRequest): Promise<void> {
  try {
    const result = await runTool(name, args ?? {})
    window.api.sendMcpResult(callId, { ok: true, result })
  } catch (err) {
    window.api.sendMcpResult(callId, {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}
