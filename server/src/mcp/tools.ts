// The trek-dev MCP tools on the server (decision 5 of phase 2e). Names, parameters and
// result shapes follow the desktop MCP server that phase 4e retired.
// Every tool acts on the calling session's project only, and changes state through
// the v2 commands, run in process.
import { randomUUID } from 'node:crypto'
import type { BranchData, Project, Repository, Session } from '../../../src/shared/model/types'
import { keySequence } from '../../../src/shared/keys.ts'
import { isProviderId } from '../../../src/shared/providers/registry.ts'
import { sanitizeLlmSelection } from '../../../src/shared/providers/selection.ts'
import { PROVIDER_IDS, type LlmSelection } from '../../../src/shared/providers/types.ts'
import { parseTicketWith, ticketView } from '../../../src/shared/tickets.ts'
import type { SessionType } from '../../../src/shared/types'
import type { ConfigStore } from '../configStore'
import { codedError } from '../errors.ts'
import type { GitPoller } from '../git/poller.ts'
import type { ProjectState } from '../projects/state.ts'
import { checkTitle, MAX_PTY_WRITE, MAX_QUEUE_ENTRY, MAX_SESSION_TYPES } from '../sessions/limits.ts'
import { findSession, type FoundSession } from '../sessions/locate.ts'
import type { SessionManager } from '../sessions/manager.ts'
import type { TopicHub } from '../topicHub'
import { dispatchV2, type V2Context } from '../v2.ts'
import { describeWorktree, resolveWorktree } from './describe.ts'
import type { PromoteRequests } from '../promote/requests.ts'
import { MAX_PROMOTE_QUEUED_ERROR } from '../../../src/shared/promote.ts'
import type { ToolDefinition } from './protocol.ts'
import type { PluginRegistry } from '../plugins/registry.ts'
import { projectTopic } from '../../../src/shared/model/topics.ts'
import type { Machine } from '../integrations/machineHandlers.ts'
import { stackState, stackUrls, stripAnsi } from '../../../src/shared/stacks.ts'
import type { StackStatus } from '../../../src/shared/types'
import { MAX_INITIAL_LOG } from '../../../src/host/stackService.ts'
import type { PrWatcher } from '../prWatch/watcher.ts'
import { isOutdated, sourceKey, sourceLabel } from '../../../src/shared/review.ts'
import type { ChangesSource } from '../../../src/shared/types'

/** The most distinct sources get_review_comments diffs to say which comments are outdated. */
const MAX_OUTDATED_SOURCES = 5

const WORKTREE_PARAM = {
  type: 'string',
  description:
    'Worktree id, path, branch or name, as returned by list_worktrees. A branch or name in several repositories is an error: pass the path.'
}
const TERMINAL_PARAM = { type: 'string', description: 'Session terminalId from list_worktrees' }
const SESSION_TYPE_PARAM = {
  type: 'string',
  description: 'Session type id or name (case-insensitive), as returned by list_session_types'
}

const STACK_DESCRIPTION =
  "A worktree's dev stack is the repo's docker/stack/stack.sh, run on the Trek server's machine: its own docker compose project (trek-<name>), Trek_<name> database, Cosmos database and block of ports, running side by side with other worktrees' stacks."

const LLM_PARAMS = {
  provider: {
    type: 'string',
    enum: [...PROVIDER_IDS],
    description: "Optional agent CLI to run. Defaults to the session type's agent, then the project/app default."
  },
  model: { type: 'string', description: "Optional model id (with provider). Omit for the agent's default." },
  effort: { type: 'string', description: 'Optional effort level (with provider), e.g. high.' }
}

export const MCP_TOOLS: ToolDefinition[] = [
  {
    name: 'list_worktrees',
    description:
      'List every git worktree of the project with branch, workflow tag, custom tags, ticket, PR, note, git status, whether it is the primary checkout, whether its sessions are loaded, and its agent sessions (terminalId, title, status, llm — the provider/model/effort it runs — queue — the prompts queued in its Queue panel, oldest first). Status is one of working, attention (waiting on input), done, complete, idle, exited.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_current_session',
    description:
      'The agent session calling this tool and the worktree it runs in. Pass the TREK_TERMINAL_ID environment variable of your shell (echo $TREK_TERMINAL_ID). Returns terminalId, title, status, llm, queue and the worktree, in the same shape as a list_worktrees entry.',
    inputSchema: {
      type: 'object',
      properties: { terminalId: { type: 'string', description: 'Value of $TREK_TERMINAL_ID' } },
      required: ['terminalId']
    }
  },
  {
    name: 'request_decision',
    description:
      "Tell the user you need them to make a decision before you can continue. Flags your session for every Trek client of this server and lists it in their notifications; it clears when the user types in your session or dismisses it. Call it whenever you stop to ask the user to choose between options or approve an approach, after writing the question and options in your reply, then end your turn and wait for their answer. Pass the TREK_TERMINAL_ID environment variable of your shell (echo $TREK_TERMINAL_ID).",
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: { type: 'string', description: 'Value of $TREK_TERMINAL_ID' },
        question: {
          type: 'string',
          description: 'One-line summary of the decision needed, shown in the notification. Line breaks and tabs become spaces; other control characters are refused. At most 1000 characters'
        }
      },
      required: ['terminalId', 'question']
    }
  },
  {
    name: 'create_worktree',
    description:
      'Create a git worktree for a branch next to the repository (<repo>-<branch>) and add it to the project. By default cuts a new branch from the latest master/main (fetched from origin first); set existingBranch to check out a branch that already exists. Shared project dirs are linked in and the branch gets the first workflow tag. Returns the new worktree in the same shape as a list_worktrees entry — use start_session to start an agent session in it.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch name' },
        existingBranch: {
          type: 'boolean',
          description: 'Check out an existing branch instead of creating a new one (default false)'
        },
        repo: {
          type: 'string',
          description:
            'Repository name or id (the repo field of list_worktrees). Required when the project has more than one repository.'
        }
      },
      required: ['branch']
    }
  },
  {
    name: 'start_session',
    description:
      "Start a new agent session in a worktree (the default agent unless provider is given). Optionally starts it as a session type (named after the type, with the type's system prompt appended) and sends a first prompt once the agent is ready. Returns the new terminalId.",
    inputSchema: {
      type: 'object',
      properties: {
        worktree: WORKTREE_PARAM,
        sessionType: { ...SESSION_TYPE_PARAM, description: `Optional. ${SESSION_TYPE_PARAM.description}` },
        prompt: { type: 'string', description: 'Optional first prompt to send' },
        ...LLM_PARAMS
      },
      required: ['worktree']
    }
  },
  {
    name: 'list_session_types',
    description:
      'List the configured session types (id, name, systemPrompt, initialMessage, llm). A session type is a named system prompt and optional first message, e.g. a "Review" session that knows how to review code; pass one to start_session.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'save_session_type',
    description:
      'Create or update a session type. Updates the type matching id (or, without id, an existing type with the same name); otherwise creates a new one. Returns the saved type.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the type to update' },
        name: { type: 'string', description: 'Name — the menu label and the tab title of its sessions' },
        systemPrompt: { type: 'string', description: "Appended to the agent's system prompt (sent ahead of the first message for agents without one)" },
        initialMessage: {
          type: 'string',
          description: 'Sent as the first message when a session of this type starts; empty for none'
        },
        llm: {
          type: ['object', 'null'],
          description: 'Agent for sessions of this type: { provider, model?, effort? }. null = use the default.',
          properties: LLM_PARAMS
        }
      }
    }
  },
  {
    name: 'delete_session_type',
    description: 'Delete a session type. Sessions already started from it keep their prompt.',
    inputSchema: {
      type: 'object',
      properties: { sessionType: SESSION_TYPE_PARAM },
      required: ['sessionType']
    }
  },
  {
    name: 'load_worktree',
    description: "Resume a worktree's saved sessions.",
    inputSchema: { type: 'object', properties: { worktree: WORKTREE_PARAM }, required: ['worktree'] }
  },
  {
    name: 'unload_worktree',
    description:
      "Unload a worktree's sessions to free resources. They are saved and resume on the next load.",
    inputSchema: { type: 'object', properties: { worktree: WORKTREE_PARAM }, required: ['worktree'] }
  },
  {
    name: 'remove_worktree',
    description:
      'Delete a linked worktree: its directory, git\'s record of it and its row. The branch is kept. Refused for the primary checkout and for a loaded worktree (unload_worktree first, which ends its sessions). A worktree with uncommitted or untracked changes is refused unless force is true, which discards them.',
    inputSchema: {
      type: 'object',
      properties: {
        worktree: WORKTREE_PARAM,
        force: { type: 'boolean', description: 'Remove it even with uncommitted or untracked changes, discarding them. Default false.' }
      },
      required: ['worktree']
    }
  },
  {
    name: 'send_prompt',
    description:
      "Type a prompt into a session's agent input and submit it. Slash commands and skills work too, e.g. \"/test-in-docker\".",
    inputSchema: {
      type: 'object',
      properties: { terminalId: TERMINAL_PARAM, text: { type: 'string' } },
      required: ['terminalId', 'text']
    }
  },
  {
    name: 'enqueue_prompt',
    description:
      "Add a prompt to the end of a session's Queue panel without sending it. The user sends queued prompts by clicking them; use send_prompt to submit immediately.",
    inputSchema: {
      type: 'object',
      properties: { terminalId: TERMINAL_PARAM, text: { type: 'string' } },
      required: ['terminalId', 'text']
    }
  },
  {
    name: 'remove_queued_prompt',
    description:
      "Remove a prompt from a session's queue by its 0-based index (as listed in list_worktrees, oldest first).",
    inputSchema: {
      type: 'object',
      properties: { terminalId: TERMINAL_PARAM, index: { type: 'integer', minimum: 0 } },
      required: ['terminalId', 'index']
    }
  },
  {
    name: 'send_keys',
    description:
      'Send keystrokes to a session, e.g. to answer a permission prompt or interrupt. Named keys: enter, escape, tab, shift-tab, up, down, left, right, backspace, space, ctrl-c, ctrl-d. Any other entry is typed literally.',
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: TERMINAL_PARAM,
        keys: { type: 'array', items: { type: 'string' } }
      },
      required: ['terminalId', 'keys']
    }
  },
  {
    name: 'read_terminal',
    description: "Read the last lines of a session's terminal screen and scrollback.",
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: TERMINAL_PARAM,
        lines: { type: 'number', description: 'How many lines (default 80, max 2000)' }
      },
      required: ['terminalId']
    }
  },
  {
    name: 'wait_for_sessions',
    description:
      'Block until sessions stop working (status becomes done, attention, idle, complete or exited), or the timeout passes. Returns each session status.',
    inputSchema: {
      type: 'object',
      properties: {
        terminalIds: { type: 'array', items: { type: 'string' } },
        until: {
          type: 'string',
          enum: ['all', 'any'],
          description: 'Wait for all sessions (default) or the first one'
        },
        timeoutSeconds: { type: 'number', description: 'Default 300, max 600' }
      },
      required: ['terminalIds']
    }
  },
  {
    name: 'close_session',
    description: 'Close a session for good, killing its agent process.',
    inputSchema: { type: 'object', properties: { terminalId: TERMINAL_PARAM }, required: ['terminalId'] }
  },
  {
    name: 'set_worktree_tag',
    description:
      "Set a worktree branch's workflow tag, by name (case-insensitive). Tags are configured per project; an unknown name fails with the list of valid tags. Omit tag to clear it.",
    inputSchema: {
      type: 'object',
      properties: { worktree: WORKTREE_PARAM, tag: { type: 'string' } },
      required: ['worktree']
    }
  },
  {
    name: 'set_worktree_custom_tag',
    description:
      "Turn one of a worktree branch's custom tags on or off, by name (case-insensitive). A branch can carry any number of custom tags alongside its workflow tag. Custom tags are configured per project; an unknown name fails with the list of valid ones.",
    inputSchema: {
      type: 'object',
      properties: {
        worktree: WORKTREE_PARAM,
        tag: { type: 'string' },
        enabled: { type: 'boolean', description: 'true (default) to add the tag, false to remove it' }
      },
      required: ['worktree', 'tag']
    }
  },
  {
    name: 'set_worktree_note',
    description: "Replace a worktree branch's free-form note. An empty note clears it.",
    inputSchema: {
      type: 'object',
      properties: { worktree: WORKTREE_PARAM, note: { type: 'string' } },
      required: ['worktree', 'note']
    }
  },
  {
    name: 'set_worktree_ticket',
    description:
      'Link a worktree branch to a ticket of a tracker on in this project (its id or URL: a Linear issue such as TOW-123 or https://linear.app/<workspace>/issue/TOW-123, an Azure DevOps work item, as the project has them on). Omit ticket to unlink it. An unrecognised ticket says which trackers are on.',
    inputSchema: {
      type: 'object',
      properties: { worktree: WORKTREE_PARAM, ticket: { type: 'string' } },
      required: ['worktree']
    }
  },
  {
    name: 'get_stack',
    description: `${STACK_DESCRIPTION} Returns whether the worktree has one, its state (starting, running, stopping, stopped), running container count, ports and URLs (App, API, Admin).`,
    inputSchema: { type: 'object', properties: { worktree: WORKTREE_PARAM }, required: ['worktree'] }
  },
  {
    name: 'start_stack',
    description: `${STACK_DESCRIPTION} Starts it in the background (stack.sh up) and returns immediately; poll get_stack until state is running and read_stack_log for progress. A first start restores the database and can take minutes.`,
    inputSchema: {
      type: 'object',
      properties: {
        worktree: WORKTREE_PARAM,
        starter: {
          type: 'boolean',
          description:
            'Restore a new stack database from the starter dataset (a year of history) instead of the default slim one. Only matters for a stack whose database does not exist yet.'
        }
      },
      required: ['worktree']
    }
  },
  {
    name: 'stop_stack',
    description: `${STACK_DESCRIPTION} Stops it (stack.sh down): removes its containers but keeps its database for the next start. Waits until stopped.`,
    inputSchema: { type: 'object', properties: { worktree: WORKTREE_PARAM }, required: ['worktree'] }
  },
  {
    name: 'read_stack_log',
    description: `${STACK_DESCRIPTION} Returns the last lines of the stack.sh output (setup steps, then the App, API, nodeapp and admin container logs), from the log's last 64 KiB.`,
    inputSchema: {
      type: 'object',
      properties: {
        worktree: WORKTREE_PARAM,
        lines: { type: 'number', description: 'Lines from the end (default 100, max 2000)' }
      },
      required: ['worktree']
    }
  },
  {
    name: 'set_worktree_pull_request',
    description:
      'Link a worktree branch to a GitHub pull request: its URL (https://github.com/<owner>/<repo>/pull/123), or just the number (123 or #123) when the repository already has another PR linked to infer the repo from. Omit pullRequest to unlink it.',
    inputSchema: {
      type: 'object',
      properties: { worktree: WORKTREE_PARAM, pullRequest: { type: 'string' } },
      required: ['worktree']
    }
  },
  {
    name: 'get_review_comments',
    description:
      "Read the user's draft review of a worktree: the line comments they wrote in Trek's Changes tab, not yet sent. Each has the file, the side (new: an added or unchanged line; old: a removed line), the line number, the line's text when the comment was written, the comment, the diff it was written on (the branch against its base, the uncommitted changes, or one commit) and whether it is outdated (its line no longer reads the same in that diff; null when that could not be checked). Read-only: the user sends the review to a session themselves.",
    inputSchema: { type: 'object', properties: { worktree: WORKTREE_PARAM }, required: ['worktree'] }
  },
  {
    name: 'watch_pull_request',
    description:
      "Watch (or stop watching) a worktree branch's linked GitHub pull request. The Trek server polls it with gh every few minutes; when its checks fail or pass, new reviews or comments arrive, it gets a merge conflict, or it is merged or closed, a prompt saying so is queued on the worktree's newest agent session and the user is notified. The watch ends by itself after merged or closed. Link the PR first with set_worktree_pull_request. Needs gh signed in on the server's machine.",
    inputSchema: {
      type: 'object',
      properties: {
        worktree: WORKTREE_PARAM,
        watch: { type: 'boolean', description: 'false stops watching (default true)' }
      },
      required: ['worktree']
    }
  },
  {
    name: 'promote_to_primary',
    description:
      "Ask the user to promote a worktree to the primary checkout: its branch is checked out in the repository's main checkout (which must have no uncommitted changes), its own uncommitted work is carried there, and the worktree is removed. Its Claude and local-model sessions move to the main checkout and resume; others are closed. Every Trek window with this project open shows a confirmation; the call waits (up to 15 minutes) for the user's answer and fails if they decline, if the promote fails, or if no window has the project open. A second call for the same worktree while one waits gets the same answer. Returns the main checkout in the same shape as a list_worktrees entry. Pass your $TREK_TERMINAL_ID as terminalId so the dialog can say who asked. If you run in the worktree being promoted, you are stopped and resumed in the main checkout, so this call never returns to you: a prompt saying how it went is queued in your session's Queue panel instead (not sent; the user sends it).",
    inputSchema: {
      type: 'object',
      properties: { worktree: WORKTREE_PARAM, terminalId: { type: 'string', description: 'Value of $TREK_TERMINAL_ID (optional)' } },
      required: ['worktree']
    }
  }
]

export const MCP_INSTRUCTIONS =
  "Controls this Trek project on the Trek server; every tool acts on this project only. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them, create_worktree to add one, start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), and wait_for_sessions and read_terminal to follow progress. The set_worktree_* tools record a branch's workflow tag, custom tags, note, ticket and pull request, and watch_pull_request has the server follow that pull request's checks, reviews and merge state. get_review_comments reads the user's draft line comments on a worktree's changes. get_stack/start_stack/stop_stack/read_stack_log run a worktree's dev stack on the server's machine. promote_to_primary asks the user to check a worktree's branch out in the main checkout (they confirm in a Trek window). A session can find itself with get_current_session, passing its $TREK_TERMINAL_ID. Any session that stops to ask the user to make a decision should call request_decision so Trek flags it."

export interface ToolDeps {
  /** The server's plugins: their project settings (phase 2) and ticket providers */
  plugins?: PluginRegistry
  store: ConfigStore
  hub: TopicHub
  projects: ProjectState
  poller: GitPoller
  sessions: SessionManager
  /** The dev stacks on the server's machine, for the stack tools; without it they say so */
  machine?: Machine
  /** The pull request watch, for watch_pull_request; without it the tool says the server does not watch PRs */
  prWatch?: PrWatcher
  /** promote_to_primary's confirmations (5e); without it the tool says no window can confirm */
  promoteRequests?: PromoteRequests
  /** How often waits re-check session state (default 250 ms) */
  pollMs?: number
  /** wait_for_sessions waits this long first when its condition already holds (default 1.5 s) */
  graceMs?: number
  /** send_prompt's and start_session's waits for a session's first output and then for it to settle */
  readyTimeouts?: { firstOutputMs?: number; settleMs?: number }
  now?: () => number
  /** Resolves after `ms`, or early once `signal` aborts (default: an unref'd timer) */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** `signal` aborts when the client that made the call goes away. */
export type ToolCall = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>

/** wait_for_sessions takes at most this many (distinct) sessions. */
export const MAX_WAIT_IDS = 50
/** Tool waits (wait_for_sessions, and send_prompt's and start_session's readiness waits) running at once in one project. */
export const MAX_WAITS_PER_PROJECT = 16

/** Resolves after `ms`, or as soon as `signal` aborts; its timer never holds the process open. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref()
    signal?.addEventListener('abort', done, { once: true })
  })
}

const bad = (message: string): Error => codedError('BAD_REQUEST', message)
const notFound = (message: string): Error => codedError('NOT_FOUND', message)
const disconnected = (): Error => new Error('the client disconnected')
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** A string argument, trimmed; absent or null reads as ''. Any other type is refused rather than read as empty. */
function strArg(value: unknown, field: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw bad(`${field} must be a string`)
  return value.trim()
}

/** Like strArg, for ticket and PR references that agents often pass as a bare number. */
function refArg(value: unknown, field: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return strArg(value, field)
}

/** A string argument that must stay verbatim (not trimmed); absent or null is undefined. */
function rawArg(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw bad(`${field} must be a string`)
  return value
}

/** Matches a tag by id or name, case-insensitively; skips malformed saved entries. */
const tagMatches = (t: { id?: unknown; name?: unknown }, name: string): boolean =>
  typeof t?.name === 'string' && (String(t.id).toLowerCase() === name.toLowerCase() || t.name.toLowerCase() === name.toLowerCase())
const tagNames = (tags: { name?: unknown }[]): string =>
  tags.flatMap((t) => (typeof t?.name === 'string' ? [t.name] : [])).join(', ') || 'none configured'

/** The repository a create_worktree call targets: by id, then name (case-insensitive). Required once a project has several. */
function targetRepository(project: Project, ref: unknown): Repository {
  const repositories = project.repositories
  const name = text(ref)
  const valid = repositories.map((r) => r.name).join(', ')
  if (!name) {
    if (repositories.length === 1) return repositories[0]
    throw bad(`repo is required in this project. Repositories: ${valid}`)
  }
  const byId = repositories.find((r) => r.id === name)
  if (byId) return byId
  const byName = repositories.filter((r) => r.name.toLowerCase() === name.toLowerCase())
  if (byName.length > 1) throw bad(`"${name}" matches more than one repository. Use its id.`)
  if (byName.length === 0) throw notFound(`Unknown repo "${name}". Repositories: ${valid}`)
  return byName[0]
}

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i

/** A GitHub PR URL, or a number whose owner/repo come from another PR linked in the same repository. */
function pullRequestUrl(input: string, repo: Repository): string {
  const url = input.match(PR_URL)
  if (url) return `https://github.com/${url[1]}/${url[2]}/pull/${url[3]}`
  const num = input.match(/^#?(\d+)$/)
  if (!num) throw bad(`Unrecognised pull request "${input}". Use its GitHub URL or number.`)
  const known = Object.values(repo.branchData)
    .map((d) => d.pr?.match(PR_URL))
    .find(Boolean)
  if (!known) throw bad('No other PR is linked to infer the repo from — pass the full GitHub URL')
  return `https://github.com/${known[1]}/${known[2]}/pull/${num[1]}`
}

/** A { provider, model?, effort? } argument; `required` when the caller passed an llm object. */
function llmArg(args: Record<string, unknown>, required = false): LlmSelection | undefined {
  if (args.provider === undefined || args.provider === '') {
    if (required) throw bad('llm needs a provider')
    if ((args.model !== undefined && args.model !== '') || (args.effort !== undefined && args.effort !== '')) {
      throw bad('model and effort need a provider')
    }
    return undefined
  }
  if (!isProviderId(args.provider)) {
    throw bad(`Unknown provider "${String(args.provider)}". Use one of: ${PROVIDER_IDS.join(', ')}`)
  }
  return sanitizeLlmSelection({ provider: args.provider, model: args.model, effort: args.effort })
}

/** Session types as tools return them — the icon data URL is just noise to an agent. */
function withoutIcon(type: SessionType): Omit<SessionType, 'icon'> {
  const { icon: _icon, ...rest } = type
  return rest
}

function findSessionType(types: SessionType[], ref: string): SessionType | undefined {
  const name = ref.trim().toLowerCase()
  return types.find((t) => t.id === ref || (typeof t?.name === 'string' && t.name.trim().toLowerCase() === name))
}

/** Returns `(projectId) => call`: the tool caller for one project's sessions. */
export function createToolCaller(deps: ToolDeps): (projectId: string) => ToolCall {
  const ctx: V2Context = {
    store: deps.store,
    hub: deps.hub,
    projects: deps.projects,
    poller: deps.poller,
    sessions: deps.sessions,
    machine: deps.machine,
    prWatch: deps.prWatch,
    plugins: deps.plugins,
    // Tool calls subscribe to nothing and attach to no pty.
    subscriber: { send() {} },
    terminal: { send() {}, bufferedAmount: () => 0 }
  }

  /** projectId → tool waits in progress */
  const waits = new Map<string, number>()

  return (projectId) => {
    /** Runs a v2 command on this project; a refusal throws with its code and message. */
    const v2 = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      const outcome = await dispatchV2(method, { ...params, projectId }, ctx)
      if (!outcome.ok) throw codedError(outcome.error.code, outcome.error.message, outcome.error.details)
      return outcome.result
    }

    /** The worktree's repository and branch; a detached worktree has no branch data. */
    const branchOf = (project: Project, ref: unknown): { repo: Repository; branch: string } => {
      const { repo, worktree } = resolveWorktree(project, ref)
      if (!worktree.branch) throw bad('That worktree has no branch (detached HEAD)')
      return { repo, branch: worktree.branch }
    }

    const branchData = (repo: Repository, branch: string): BranchData =>
      Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : {}

    const describeById = (worktreeId: string) => {
      const project = deps.projects.require(projectId)
      for (const repo of project.repositories) {
        const w = repo.worktrees.find((x) => x.id === worktreeId)
        if (w) return describeWorktree(project, repo, w)
      }
      throw notFound(`No worktree with id "${worktreeId}" in this project`)
    }

    const saveSessionTypes = (types: SessionType[]) => v2('project.updateSettings', { settings: { sessionTypes: types } })

    const pollMs = deps.pollMs ?? 250
    const graceMs = deps.graceMs ?? 1500
    const firstOutputMs = deps.readyTimeouts?.firstOutputMs ?? 60_000
    const settleMs = deps.readyTimeouts?.settleMs ?? 30_000
    const now = deps.now ?? Date.now
    const sleep = deps.sleep ?? abortableSleep

    /** The session `terminalId` names, in `project` (default: the current snapshot); NOT_FOUND reads "No session …". */
    const sessionIn = (terminalId: unknown, project: Project = deps.projects.require(projectId)): FoundSession => {
      if (typeof terminalId !== 'string' || !terminalId) throw bad('terminalId is required')
      return findSession(project, terminalId)
    }

    /** As sessionIn, for a worktree session: as on the desktop, tools leave the Global session alone. */
    const targetIn = (terminalId: unknown, project?: Project): FoundSession => {
      const found = sessionIn(terminalId, project)
      if (!found.worktree) throw bad("the Global session can't be targeted by tools")
      return found
    }

    /** Runs `fn` holding one of the project's wait slots; CAPACITY when they are all taken. */
    const withWait = async <T>(fn: () => Promise<T>): Promise<T> => {
      const held = waits.get(projectId) ?? 0
      if (held >= MAX_WAITS_PER_PROJECT) throw codedError('CAPACITY', 'too many waits in progress')
      waits.set(projectId, held + 1)
      try {
        return await fn()
      } finally {
        const left = (waits.get(projectId) ?? 1) - 1
        if (left > 0) waits.set(projectId, left)
        else waits.delete(projectId)
      }
    }

    /** The session's record now, or undefined once it (or the project) is gone. */
    const current = (terminalId: string): Session | undefined => {
      try {
        return sessionIn(terminalId).session
      } catch {
        return undefined
      }
    }

    /**
     * Exited, or not working and past its first output. A session that has printed
     * nothing yet (just started or restarted) is still booting, whatever its status.
     */
    const settled = (session: Session): boolean =>
      session.status === 'exited' || (session.status !== 'working' && deps.sessions.hasOutput(session.id))

    /**
     * Polls every pollMs; true once `predicate` holds, false if `timeoutMs` passes first.
     * Throws "the client disconnected" once `signal` aborts.
     */
    const waitFor = async (predicate: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> => {
      const deadline = now() + timeoutMs
      for (;;) {
        if (signal?.aborted) throw disconnected()
        if (predicate()) return true
        const left = deadline - now()
        if (left <= 0) return false
        await sleep(Math.min(pollMs, left), signal)
      }
    }

    /**
     * A session that has not printed anything yet is still booting (the desktop's
     * `starting`): wait for its first output, then for it to settle. Neither timeout
     * throws; an aborted `signal` does. The caller holds a wait slot.
     */
    const waitUntilReady = async (terminalId: string, signal?: AbortSignal): Promise<void> => {
      if (deps.sessions.hasOutput(terminalId)) return
      const gone = (s: Session | undefined) => !s || s.status === 'exited'
      await waitFor(() => { const s = current(terminalId); return gone(s) || deps.sessions.hasOutput(terminalId) }, firstOutputMs, signal)
      await waitFor(() => { const s = current(terminalId); return gone(s) || s!.status !== 'working' }, settleMs, signal)
    }

    /** The session's live pty; BAD_REQUEST when it is not running. */
    const runningPty = (session: Session): string => {
      const ptyId = session.ptyId
      if (!ptyId || !deps.sessions.terminals.has(ptyId)) throw bad('That session is not running')
      return ptyId
    }

    const describeSession = ({ session, repo, worktree }: FoundSession) => {
      const project = deps.projects.require(projectId)
      return {
        terminalId: session.id,
        title: session.title,
        status: session.status,
        llm: session.llm,
        queue: session.queue,
        decision: session.decision?.question ?? null,
        worktree: repo && worktree ? describeWorktree(project, repo, worktree) : null
      }
    }

    /** A stack as the tools describe it (the desktop's describeStack). */
    const describeStack = (status: StackStatus) => ({
      name: status.slug ? `trek-${status.slug}` : null,
      state: stackState(status),
      containers: status.containers,
      ports: status.port ? { first: status.port, last: status.port + 5 } : null,
      urls: Object.fromEntries(stackUrls(status).map((u) => [u.label, u.url])),
      logins: 'admin or bill, password sample123'
    })

    /** get_stack, start_stack, stop_stack and read_stack_log, through the stack.* commands (their checks and the allowlist). */
    const stackTool = async (name: string, args: Record<string, unknown>, project: Project): Promise<unknown> => {
      const { worktree } = resolveWorktree(project, args.worktree)
      if (!deps.machine) throw bad('This Trek server does not run dev stacks')
      const ref = { worktreeId: worktree.id }
      const status = (await v2('stack.status', ref)) as StackStatus
      if (!status.available) {
        if (name === 'get_stack') return { available: false }
        throw bad('That worktree has no docker/stack/stack.sh')
      }
      switch (name) {
        case 'start_stack': {
          if (args.starter !== undefined && typeof args.starter !== 'boolean') throw bad('starter must be a boolean')
          const state = stackState(status)
          if (state !== 'stopped') throw bad(`The stack is already ${state}`)
          await v2('stack.up', { ...ref, starter: args.starter === true })
          return describeStack((await v2('stack.status', ref)) as StackStatus)
        }
        case 'stop_stack': {
          const code = await v2('stack.down', ref)
          if (code !== 0) throw bad(`stack.sh down exited with code ${String(code)} — see read_stack_log`)
          return describeStack((await v2('stack.status', ref)) as StackStatus)
        }
        case 'read_stack_log': {
          if (args.lines !== undefined && typeof args.lines !== 'number') throw bad('lines must be a number')
          // Clamped before flooring, so 0.5 is one line; 0, NaN and no value are the default.
          const requested = Number(args.lines)
          const lines = requested ? Math.floor(Math.min(Math.max(requested, 1), 2000)) : 100
          // fileId 0 names no log: the answer is the current log's last 64 KiB (offset is its size).
          const { text, offset } = (await v2('stack.log', { ...ref, fileId: 0, offset: 0 })) as { text: string; offset: number }
          // The log ends in a newline, which ends the last line rather than starting an empty one.
          let all = stripAnsi(text).replace(/\n+$/, '').split('\n')
          // A log longer than what was read starts mid-line: leave that piece out.
          if (offset > MAX_INITIAL_LOG) all = all.slice(1)
          return { output: all.slice(-lines).join('\n') }
        }
        default:
          return { available: true, ...describeStack(status) }
      }
    }

    const handlers: Record<string, (args: Record<string, unknown>, project: Project, signal?: AbortSignal) => unknown> = {
      list_worktrees: (_args, project) =>
        project.repositories.flatMap((repo) => repo.worktrees.map((w) => describeWorktree(project, repo, w))),

      create_worktree: async (args, project) => {
        const branch = text(args.branch)
        if (!branch) throw bad('branch is required')
        const repo = targetRepository(project, args.repo)
        const { worktreeId } = (await v2('worktree.create', {
          repoId: repo.id,
          branch,
          createBranch: args.existingBranch !== true
        })) as { worktreeId: string }
        return describeById(worktreeId)
      },

      load_worktree: async (args, project) => {
        const { worktree } = resolveWorktree(project, args.worktree)
        await v2('worktree.load', { worktreeId: worktree.id })
        return { loaded: true, sessions: describeById(worktree.id).sessions }
      },

      unload_worktree: async (args, project) => {
        const { worktree } = resolveWorktree(project, args.worktree)
        await v2('worktree.unload', { worktreeId: worktree.id })
        return { unloaded: true }
      },

      remove_worktree: async (args, project) => {
        if (args.force !== undefined && typeof args.force !== 'boolean') throw bad('force must be a boolean')
        const { worktree } = resolveWorktree(project, args.worktree)
        try {
          await v2('worktree.remove', { worktreeId: worktree.id, force: args.force === true })
        } catch (err) {
          if ((err as { details?: { reason?: string } }).details?.reason === 'dirty') {
            throw codedError('GIT_ERROR', `${worktree.path} has uncommitted or untracked changes; pass force: true to discard them`, { reason: 'dirty' })
          }
          throw err
        }
        return { removed: true, path: worktree.path, branch: worktree.branch ?? null }
      },

      set_worktree_tag: async (args, project) => {
        const { repo, branch } = branchOf(project, args.worktree)
        const name = strArg(args.tag, 'tag')
        const tags = project.settings.worktreeTags ?? []
        const tag = name ? tags.find((t) => tagMatches(t, name)) : null
        if (tag === undefined) throw bad(`Unknown tag "${name}". Valid tags: ${tagNames(tags)}`)
        await v2('branch.setTag', { repoId: repo.id, branch, tag: tag?.id ?? null })
        return { branch, tag: tag?.name ?? null }
      },

      set_worktree_custom_tag: async (args, project) => {
        const { repo, branch } = branchOf(project, args.worktree)
        const name = strArg(args.tag, 'tag')
        if (args.enabled !== undefined && typeof args.enabled !== 'boolean') throw bad('enabled must be a boolean')
        const tags = project.settings.customTags ?? []
        const tag = name ? tags.find((t) => tagMatches(t, name)) : undefined
        if (!tag) throw bad(`Unknown custom tag "${name}". Valid custom tags: ${tagNames(tags)}`)
        const current = branchData(repo, branch).customTags ?? []
        const next = args.enabled === false
          ? current.filter((id) => id !== tag.id)
          : current.includes(tag.id) ? current : [...current, tag.id]
        await v2('branch.setCustomTags', { repoId: repo.id, branch, customTags: next })
        return { branch, customTags: next.map((id) => tags.find((t) => t?.id === id)?.name ?? id) }
      },

      set_worktree_note: async (args, project) => {
        const { repo, branch } = branchOf(project, args.worktree)
        await v2('branch.setNote', { repoId: repo.id, branch, note: rawArg(args.note, 'note') ?? '' })
        return { branch }
      },

      set_worktree_ticket: async (args, project) => {
        const { repo, branch } = branchOf(project, args.worktree)
        const input = refArg(args.ticket, 'ticket')
        if (!input) {
          await v2('branch.setTicket', { repoId: repo.id, branch, ticket: null })
          return { branch, ticket: null }
        }
        // The trackers on in this project (their plugins').
        const providers = deps.plugins?.ticketProviders(projectId) ?? []
        const parsed = parseTicketWith(providers, input)
        if (!parsed) {
          const takes = providers.length > 0 ? `Use ${providers.map((p) => p.hint).join(', or ')}.` : 'No ticket tracker is on in this project.'
          throw bad(`Unrecognised ticket "${input}". ${takes}`)
        }
        // A URL's workspace or base, written as the tracker's project settings.
        if (parsed.settings && Object.keys(parsed.settings).length > 0) await v2('project.updateSettings', { settings: parsed.settings })
        await v2('branch.setTicket', { repoId: repo.id, branch, ticket: parsed.ticketId })
        const fresh = deps.projects.require(projectId).settings as Record<string, unknown>
        return { branch, ticket: parsed.ticketId, url: ticketView(providers, fresh, parsed.ticketId).url }
      },

      set_worktree_pull_request: async (args, project) => {
        const { repo, branch } = branchOf(project, args.worktree)
        const input = refArg(args.pullRequest, 'pullRequest')
        const url = input ? pullRequestUrl(input, repo) : null
        await v2('branch.setPr', { repoId: repo.id, branch, pr: url })
        return { branch, pullRequest: url }
      },

      // Read-only (5c-2). Outdated is worked out against the comment's own source now: one
      // worktree.diff per source (its path checks and limits), at most MAX_OUTDATED_SOURCES of them,
      // each of only the files commented on in that source; a comment of a later source is null.
      get_review_comments: async (args, project) => {
        const { worktree } = resolveWorktree(project, args.worktree)
        const draft = worktree.review
        if (!draft || draft.comments.length === 0) return { worktree: worktree.id, revision: null, comments: [] }
        const sources = new Map<string, { source: ChangesSource; paths: Set<string> }>()
        for (const c of draft.comments) {
          const key = sourceKey(c.source)
          const entry = sources.get(key) ?? { source: c.source, paths: new Set<string>() }
          entry.paths.add(c.path)
          sources.set(key, entry)
        }
        const diffs = new Map<string, Record<string, string> | null>()
        for (const [key, { source, paths }] of [...sources].slice(0, MAX_OUTDATED_SOURCES)) {
          try {
            diffs.set(key, (await v2('worktree.diff', { worktreeId: worktree.id, source, paths: [...paths] })) as Record<string, string>)
          } catch {
            diffs.set(key, null) // a missing worktree, a commit gone: not checked
          }
        }
        return {
          worktree: worktree.id,
          revision: draft.revision,
          comments: draft.comments.map((c) => {
            const diff = diffs.get(sourceKey(c.source))
            return {
              id: c.id,
              file: c.path,
              side: c.side,
              line: c.line,
              lineText: c.lineText,
              comment: c.body,
              source: c.source,
              sourceLabel: sourceLabel(c.source),
              outdated: diff ? isOutdated(c, Object.hasOwn(diff, c.path) ? diff[c.path] : undefined) : null
            }
          })
        }
      },

      watch_pull_request: async (args, project) => {
        const { repo, branch } = branchOf(project, args.worktree)
        if (args.watch !== undefined && args.watch !== null && typeof args.watch !== 'boolean') throw bad('watch must be a boolean')
        const watch = args.watch !== false
        await v2('branch.setPrWatch', { repoId: repo.id, branch, watch })
        return { branch, pullRequest: branchData(repo, branch).pr ?? null, watching: watch }
      },

      // 5e: a window confirms and runs the promote; this waits for its answer.
      promote_to_primary: async (args, project, signal) => {
        const { repo, worktree } = resolveWorktree(project, args.worktree)
        if (worktree.isMain) throw bad('That worktree is already the primary checkout')
        const mainPath = repo.worktrees.find((w) => w.isMain)?.path ?? repo.path
        if (!worktree.branch) throw bad(`${worktree.path} has no branch checked out (detached HEAD); it can't be promoted`)
        let from: string | undefined
        let callerId: string | undefined
        // The asking session is only looked up in this project (for the dialog's text, and the
        // queue that hears the outcome if the call drops); nothing else is checked of it.
        if (typeof args.terminalId === 'string' && args.terminalId) {
          try {
            const caller = sessionIn(args.terminalId, project).session
            from = caller.title
            callerId = caller.id
          } catch {
            // an unknown terminal only loses the dialog's "asked by"
          }
        }
        const nobody = 'No Trek window has this project open to confirm the promote, so nothing was changed. Ask the user to open the project, or to promote it themselves.'
        if (!deps.promoteRequests) throw codedError('BAD_REQUEST', nobody)
        const branch = worktree.branch
        const answer = await deps.promoteRequests.ask(projectId, { worktreeId: worktree.id, branch, ...(from ? { from } : {}) }, signal)
        // The promote went through: describing the main checkout must never turn it into an error.
        const primaryOf = (worktreeId: string): ReturnType<typeof describeById> | undefined => {
          try {
            return describeById(worktreeId)
          } catch (err) {
            console.warn(`[promote] could not describe the main checkout ${worktreeId}: ${(err as Error).message}`)
            return undefined
          }
        }
        // The caller went away while a window ran the promote (it was the worktree's agent, stopped
        // and resumed elsewhere): its session hears how it went from its queue (never sent by itself).
        if (signal?.aborted && callerId && (answer.outcome === 'promoted' || answer.outcome === 'failed')) {
          try {
            const text =
              answer.outcome === 'promoted'
                ? `The promote you asked for (promote_to_primary) went through: ${branch} is now checked out in the main checkout at ${primaryOf(answer.worktreeId)?.path ?? mainPath}, and the worktree's Claude and local-model sessions (this one included, if it ran there) now run there.`
                : `The promote you asked for (promote_to_primary) failed: ${answer.error.slice(0, MAX_PROMOTE_QUEUED_ERROR)}`
            deps.sessions.enqueue({ projectId, sessionId: callerId, text: text.slice(0, MAX_QUEUE_ENTRY) })
            deps.sessions.refreshAttention()
          } catch (err) {
            console.warn(`[promote] could not queue the outcome for session ${callerId}: ${(err as Error).message}`)
          }
        }
        switch (answer.outcome) {
          case 'promoted': {
            const primary = primaryOf(answer.worktreeId)
            return primary ? { promoted: true, primary } : { promoted: true, path: mainPath }
          }
          case 'declined':
            throw bad('The user declined the promote; nothing was changed. Do not ask again unless they say so.')
          case 'failed':
            throw codedError('GIT_ERROR', `The promote failed: ${answer.error}`)
          case 'no-window':
            throw bad(nobody)
          case 'timeout':
            throw bad('The user did not answer within 15 minutes; nothing was changed.')
          case 'cancelled':
            throw disconnected()
        }
      },

      list_session_types: (_args, project) => (project.settings.sessionTypes ?? []).map(withoutIcon),

      save_session_type: async (args, project) => {
        const types = project.settings.sessionTypes ?? []
        const name = rawArg(args.name, 'name')?.trim()
        const systemPrompt = rawArg(args.systemPrompt, 'systemPrompt')
        const initialMessage = rawArg(args.initialMessage, 'initialMessage')
        if (name) checkTitle(name, 'name')
        for (const [field, value] of [['systemPrompt', systemPrompt], ['initialMessage', initialMessage]] as const) {
          if (value !== undefined && value.length > MAX_QUEUE_ENTRY) throw bad(`${field} must be at most ${MAX_QUEUE_ENTRY} characters`)
        }
        if (args.id !== undefined && args.id !== null && typeof args.id !== 'string') throw bad('id must be a string')
        if (args.llm !== undefined && args.llm !== null && (typeof args.llm !== 'object' || Array.isArray(args.llm))) {
          throw bad('llm must be an object { provider, model?, effort? } or null')
        }
        const llm =
          args.llm === null ? null : args.llm === undefined ? undefined : llmArg(args.llm as Record<string, unknown>, true)
        let existing: SessionType | undefined
        if (typeof args.id === 'string' && args.id) {
          existing = types.find((t) => t.id === args.id)
          if (!existing) throw notFound(`No session type with id "${args.id}"`)
        } else if (name) {
          existing = findSessionType(types, name)
        }
        if (existing) {
          const renamed = existing
          if (name && types.some((t) => t.id !== renamed.id && typeof t?.name === 'string' && t.name.trim().toLowerCase() === name.toLowerCase())) {
            throw bad(`Another session type is already named "${name}"`)
          }
          const { llm: _oldLlm, ...rest } = existing
          const updated: SessionType = {
            ...(llm === null ? rest : existing),
            ...(name ? { name } : {}),
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            ...(initialMessage !== undefined ? { initialMessage } : {}),
            ...(llm ? { llm } : {})
          }
          await saveSessionTypes(types.map((t) => (t.id === updated.id ? updated : t)))
          return withoutIcon(updated)
        }
        if (!name) throw bad('name is required to create a session type')
        if (types.length >= MAX_SESSION_TYPES) throw bad(`A project holds at most ${MAX_SESSION_TYPES} session types`)
        const created: SessionType = {
          id: randomUUID(),
          name,
          systemPrompt: systemPrompt ?? '',
          ...(initialMessage !== undefined ? { initialMessage } : {}),
          ...(llm ? { llm } : {})
        }
        await saveSessionTypes([...types, created])
        return created
      },

      delete_session_type: async (args, project) => {
        const types = project.settings.sessionTypes ?? []
        const ref = text(args.sessionType)
        if (!ref) throw bad('sessionType is required')
        const type = findSessionType(types, ref)
        if (!type) {
          const names = tagNames(types)
          throw notFound(`No session type matches "${ref}". Session types: ${names}`)
        }
        await saveSessionTypes(types.filter((t) => t.id !== type.id))
        return { deleted: type.name }
      },

      get_current_session: (args) => describeSession(sessionIn(args.terminalId)),

      start_session: async (args, project, signal) => {
        const { worktree } = resolveWorktree(project, args.worktree)
        let sessionTypeId: string | undefined
        if (args.sessionType !== undefined && args.sessionType !== '') {
          const ref = text(args.sessionType)
          const types = project.settings.sessionTypes ?? []
          const type = ref ? findSessionType(types, ref) : undefined
          if (!type) {
            const names = tagNames(types)
            throw notFound(`No session type matches "${String(args.sessionType)}". Session types: ${names}`)
          }
          sessionTypeId = type.id
        }
        const llm = llmArg(args)
        const raw = rawArg(args.prompt, 'prompt')
        const prompt = raw?.trim() ? raw : undefined
        // Checked before the start: once the session exists, its id must reach the caller.
        if (prompt && prompt.length > MAX_PTY_WRITE) throw bad(`prompt must be at most ${MAX_PTY_WRITE} characters`)
        const start = async (): Promise<string> => {
          const { sessionId } = (await v2('session.start', {
            worktreeId: worktree.id,
            ...(sessionTypeId ? { sessionTypeId } : {}),
            ...(llm ? { llm } : {}),
            cols: 120,
            rows: 32
          })) as { sessionId: string }
          return sessionId
        }
        const statusOf = (sessionId: string) => current(sessionId)?.status ?? 'closed'
        if (!prompt) {
          const sessionId = await start()
          return { terminalId: sessionId, status: statusOf(sessionId) }
        }
        // The slot is taken before the start, so a CAPACITY refusal leaves no session behind.
        return withWait(async () => {
          const sessionId = await start()
          const unsent = (reason: string) => ({ terminalId: sessionId, status: statusOf(sessionId), promptSent: false, reason })
          try {
            await waitUntilReady(sessionId, signal)
          } catch (err) {
            return unsent(messageOf(err))
          }
          if (signal?.aborted) return unsent(messageOf(disconnected()))
          const session = current(sessionId)
          if (!session) return unsent('the session was closed before it was ready')
          if (session.status === 'exited') return unsent('the session exited before it was ready')
          try {
            await v2('session.sendPrompt', { sessionId, text: prompt })
          } catch (err) {
            return unsent(messageOf(err))
          }
          return { terminalId: sessionId, status: statusOf(sessionId), promptSent: true }
        })
      },

      request_decision: (args) => {
        // Global sessions may ask too, so this does not go through targetIn.
        const { session } = sessionIn(args.terminalId)
        deps.sessions.requestDecision({ projectId, sessionId: session.id, question: args.question })
        return { notified: true }
      },

      get_stack: (args, project) => stackTool('get_stack', args, project),
      start_stack: (args, project) => stackTool('start_stack', args, project),
      stop_stack: (args, project) => stackTool('stop_stack', args, project),
      read_stack_log: (args, project) => stackTool('read_stack_log', args, project),

      close_session: async (args) => {
        const { session } = targetIn(args.terminalId)
        await v2('session.close', { sessionId: session.id })
        return { closed: true }
      },

      send_prompt: async (args, _project, signal) => {
        const { session } = targetIn(args.terminalId)
        if (typeof args.text !== 'string' || !args.text.trim()) throw bad('text is required')
        if (session.status === 'exited') throw bad('That session has exited')
        if (!deps.sessions.hasOutput(session.id)) await withWait(() => waitUntilReady(session.id, signal))
        if (signal?.aborted) throw disconnected()
        await v2('session.sendPrompt', { sessionId: session.id, text: args.text })
        return { sent: true }
      },

      enqueue_prompt: async (args) => {
        const { session } = targetIn(args.terminalId)
        const prompt = text(args.text)
        if (!prompt) throw bad('text is required')
        await v2('session.enqueue', { sessionId: session.id, text: prompt })
        return { queue: sessionIn(session.id).session.queue }
      },

      remove_queued_prompt: async (args) => {
        const { session } = targetIn(args.terminalId)
        const queue = session.queue
        const index = args.index
        if (typeof index !== 'number' || !Number.isInteger(index)) throw bad('index must be an integer')
        if (index < 0 || index >= queue.length) {
          throw bad(
            queue.length
              ? `index must be 0–${queue.length - 1}; the queue has ${queue.length} prompt(s)`
              : 'The queue is empty: there is no index to remove'
          )
        }
        await v2('session.dequeue', { sessionId: session.id, index, expected: queue[index] })
        return { removed: queue[index], queue: sessionIn(session.id).session.queue }
      },

      send_keys: (args) => {
        const { session } = targetIn(args.terminalId)
        const keys = Array.isArray(args.keys) ? args.keys.map(String) : []
        if (keys.length === 0) throw bad('keys is required')
        const sequences = keys.map(keySequence)
        if (sequences.reduce((n, k) => n + k.length, 0) > MAX_PTY_WRITE) {
          throw bad(`keys must total at most ${MAX_PTY_WRITE} characters`)
        }
        const ptyId = runningPty(session)
        for (const sequence of sequences) deps.sessions.terminals.write(ptyId, sequence)
        // Same as real keyboard input: the prompt is being answered.
        deps.sessions.noteUserInput(session.id)
        return { sent: keys.length }
      },

      read_terminal: async (args) => {
        const { session } = targetIn(args.terminalId)
        const lines = Math.min(Math.max(Math.floor(Number(args.lines)) || 80, 1), 2000)
        const ptyId = runningPty(session)
        await deps.sessions.terminals.settled(ptyId)
        // The pty may have ended while its output settled.
        if (!deps.sessions.terminals.has(ptyId)) throw bad('the session is not running')
        const output = deps.sessions.terminals.screen(ptyId, lines).join('\n')
        return { status: current(session.id)?.status ?? 'closed', output }
      },

      wait_for_sessions: async (args, project, signal) => {
        const ids: unknown[] = Array.isArray(args.terminalIds) ? args.terminalIds : []
        if (ids.length === 0) throw bad('terminalIds is required')
        if (!ids.every((id) => typeof id === 'string')) throw bad('terminalIds must be strings')
        const terminalIds = [...new Set(ids as string[])]
        if (terminalIds.length > MAX_WAIT_IDS) throw bad(`terminalIds holds at most ${MAX_WAIT_IDS} sessions`)
        for (const id of terminalIds) targetIn(id, project)
        const any = args.until === 'any'
        const seconds = Math.min(Number(args.timeoutSeconds) || 300, 600)
        /** Each session's record in one project snapshot; undefined once it (or the project) is gone. */
        const snapshot = (): (Session | undefined)[] => {
          let fresh: Project
          try {
            fresh = deps.projects.require(projectId)
          } catch {
            return terminalIds.map(() => undefined)
          }
          return terminalIds.map((id) => {
            try {
              return findSession(fresh, id).session
            } catch {
              return undefined
            }
          })
        }
        const done = (s: Session | undefined): boolean => !s || settled(s)
        const holds = (): boolean => {
          const sessions = snapshot()
          return any ? sessions.some(done) : sessions.every(done)
        }
        return withWait(async () => {
          // A prompt sent a moment ago may not have produced output yet: don't report
          // its still-idle status as finished.
          if (holds()) await sleep(graceMs, signal)
          const completed = await waitFor(holds, seconds * 1000, signal)
          const sessions = snapshot()
          return {
            timedOut: !completed,
            sessions: terminalIds.map((id, i) => ({ terminalId: id, status: sessions[i]?.status ?? 'closed' }))
          }
        })
      }
    }

    return async (name, args, signal) => {
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined
      if (!handler) throw bad(`Unknown tool: ${name}`)
      if (signal?.aborted) throw disconnected()
      return handler(args ?? {}, deps.projects.require(projectId), signal)
    }
  }
}
