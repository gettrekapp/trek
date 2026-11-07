import { app, ipcMain, type WebContents } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { McpCallRequest, McpCallResponse } from '../shared/types'
import { codexHeadersHelper } from '../shared/providers/codex.ts'
import { PROVIDER_IDS, type McpAccess } from '../shared/providers/types'
import { handleBody, type BotMcpHandlers, type RpcDeps } from './mcpRpc'

export type { BotMcpHandlers } from './mcpRpc'

/**
 * MCP server (Streamable HTTP, JSON responses only) that lets the global
 * agent session drive the app: list worktrees, start/load sessions, send
 * prompts, read terminal output. Bound to loopback with a per-launch bearer
 * token per window: the token decides which window's project a call acts on.
 * Tool calls are forwarded to that window's renderer, which owns the terminals
 * and project state.
 */

export const MCP_SERVER_NAME = 'trek-dev'
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
/** Longer than the longest wait_for_sessions timeout the renderer accepts. */
const CALL_TIMEOUT_MS = 11 * 60_000

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

const LLM_PARAMS = {
  provider: {
    type: 'string',
    enum: [...PROVIDER_IDS],
    description: "Optional agent CLI to run. Defaults to the session type's agent, then the project/app default."
  },
  model: { type: 'string', description: "Optional model id (with provider). Omit for the agent's default." },
  effort: { type: 'string', description: 'Optional effort level (with provider), e.g. high.' }
}

const STACK_DESCRIPTION =
  "A local worktree's dev stack is the repo's docker/stack/stack.sh: its own docker compose project (trek-<name>), Trek_<name> database, Cosmos database and block of ports, running side by side with other worktrees' stacks."

const TOOLS = [
  {
    name: 'list_worktrees',
    description:
      'List every git worktree of the project (local and remote) with branch, workflow tag, ticket (with its Linear title and status when known), PR, note, git status, whether it is the primary checkout or the one selected in the app, whether its sessions are loaded, and its live agent sessions (terminalId, title, status, llm — the provider/model/effort it runs — decision — the open request_decision question, if any — active — the tab shown in that worktree, so the active session of the selected worktree is the one the user has open — queue — the prompts queued in its Queue panel, oldest first). Status is one of starting, working, attention (waiting on input), done, complete, idle, exited.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_selected_worktree',
    description:
      "The worktree currently selected in the app's sidebar — what the user means by \"my current/selected worktree\". Same shape as a list_worktrees entry.",
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
      "Tell the user you need them to make a decision before you can continue. Flags your tab and worktree in the app, adds an entry to its notification list and sends a desktop notification; it clears when the user types in your session or dismisses it. Call it whenever you stop to ask the user to choose between options or approve an approach, after writing the question and options in your reply, then end your turn and wait for their answer. Pass the TREK_TERMINAL_ID environment variable of your shell (echo $TREK_TERMINAL_ID).",
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: { type: 'string', description: 'Value of $TREK_TERMINAL_ID' },
        question: {
          type: 'string',
          description: 'One-line summary of the decision needed, shown in the notification'
        }
      },
      required: ['terminalId', 'question']
    }
  },
  {
    name: 'speak_summary',
    description:
      "Read a short spoken summary aloud to the user through the app's ElevenLabs voice. Keep it SHORT: one to three plain sentences (max 400 characters), written to be heard — no markdown, code, file paths, URLs or lists. Use it only when your instructions or the user ask for spoken summaries. Summaries play one at a time; it only plays while the user has the app set to Active and is skipped while they are Busy, so never repeat it. Pass the TREK_TERMINAL_ID environment variable of your shell (echo $TREK_TERMINAL_ID).",
    inputSchema: {
      type: 'object',
      properties: {
        terminalId: { type: 'string', description: 'Value of $TREK_TERMINAL_ID' },
        summary: {
          type: 'string',
          description: 'One to three short spoken sentences, at most 400 characters'
        }
      },
      required: ['terminalId', 'summary']
    }
  },
  {
    name: 'create_worktree',
    description:
      "Create a git worktree for a branch next to the repository (<repo>-<branch>) and add it to the app, without changing the user's selection. By default cuts a new branch from the latest master/main (fetched from origin first); set existingBranch to check out a branch that already exists. Shared project dirs are linked in and the branch gets the first workflow tag. Returns the new worktree in the same shape as a list_worktrees entry — use start_session to start an agent session in it.",
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
        },
        server: {
          type: 'string',
          description: 'Optional remote server name or id to create it on; defaults to the local machine'
        }
      },
      required: ['branch']
    }
  },
  {
    name: 'promote_to_primary',
    description:
      "Promote a local worktree to the primary checkout: deletes the worktree, checks its branch out in the main repository, and moves its sessions there (Codex, Gemini and Grok sessions can't move and are closed). The user must confirm in the app; uncommitted changes in either checkout block it. Returns the primary worktree afterwards.",
    inputSchema: { type: 'object', properties: { worktree: WORKTREE_PARAM }, required: ['worktree'] }
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
    name: 'focus_session',
    description: "Show a session in the app's UI (selects its worktree and tab).",
    inputSchema: { type: 'object', properties: { terminalId: TERMINAL_PARAM }, required: ['terminalId'] }
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
      "Link a worktree branch to a ticket: a Linear issue id (e.g. TOW-123) or URL (https://linear.app/<workspace>/issue/TOW-123/...), or an Azure DevOps work item id or URL. Omit ticket to unlink it.",
    inputSchema: {
      type: 'object',
      properties: { worktree: WORKTREE_PARAM, ticket: { type: 'string' } },
      required: ['worktree']
    }
  },
  {
    name: 'set_worktree_pull_request',
    description:
      'Link a worktree branch to a GitHub pull request: its URL (https://github.com/<owner>/<repo>/pull/123), or just the number (123 or #123) when the project already has another PR linked to infer the repo from. Omit pullRequest to unlink it.',
    inputSchema: {
      type: 'object',
      properties: { worktree: WORKTREE_PARAM, pullRequest: { type: 'string' } },
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
    description: `${STACK_DESCRIPTION} Returns the last lines of the stack.sh output (setup steps, then the App, API, nodeapp and admin container logs).`,
    inputSchema: {
      type: 'object',
      properties: {
        worktree: WORKTREE_PARAM,
        lines: { type: 'number', description: 'Lines from the end (default 100, max 2000)' }
      },
      required: ['worktree']
    }
  }
]

/** Offered only to bot turns, through their own token. */
const BOT_TOOLS = [
  {
    name: 'request_approval',
    description:
      'Ask the user to approve a tool call the policy denied with "Needs approval". Pass the exact tool name and input. The result says what to do next: usually end your turn, and the answer arrives in a later turn, but if the call is already approved, run it now. An approval allows one exact call.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name, e.g. Bash or mcp__trek-dev__close_session' },
        input: { type: 'object', description: 'The exact tool input. For Bash, { "command": "..." } is enough.' },
        reason: { type: 'string', description: 'One sentence on why this is needed, shown to the user' }
      },
      required: ['tool', 'input', 'reason']
    }
  }
]

let botHandlers: BotMcpHandlers | null = null

export function setBotMcpHandlers(handlers: BotMcpHandlers): void {
  botHandlers = handlers
}

const INSTRUCTIONS =
  'Controls the Trek Dev app. Each git worktree can run agent sessions (Claude, Codex, Gemini, Grok or a local model); use list_worktrees to see them (get_selected_worktree for the one the user has selected), start_session/send_prompt to delegate work or run a skill in a worktree (list_session_types for specialised session types such as reviews), wait_for_sessions and read_terminal to follow progress, and get_stack/start_stack/stop_stack to run the dev stack of a local worktree. A worktree session can find itself with get_current_session, passing its $TREK_TERMINAL_ID. Any session that stops to ask the user to make a decision should call request_decision so the app flags it.'

const pending = new Map<
  string,
  { resolve: (r: McpCallResponse) => void; timer: ReturnType<typeof setTimeout>; windowId: number }
>()

interface McpClient {
  windowId: number
  contents: WebContents
  token: string
  bot: boolean
}

/** A window's sessions, which read their token from a config file in userData. */
interface SessionClient extends McpClient {
  configPath: string
  written: Promise<void>
  /** The Gemini settings and Codex headers files, written on first non-Claude access */
  geminiWritten?: Promise<{ geminiSettingsPath: string; codexHeadersPath: string }>
}

const clients = new Map<number, SessionClient>()
/**
 * Each bot turn gets its own token, by token, so bot-only routes and tools stay out of other
 * sessions' reach. It lives from the turn's start until it settles (or the window closes), so a
 * token copied out of a turn is worthless afterwards. No file holds it: the bot's config is
 * inline, and the CLI reads the token from its environment.
 */
const botTurns = new Map<string, McpClient>()

function callRenderer(
  client: McpClient,
  name: string,
  args: Record<string, unknown>
): Promise<McpCallResponse> {
  if (client.contents.isDestroyed()) {
    return Promise.resolve({ ok: false, error: 'The app window is not open' })
  }
  const callId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(callId)
      resolve({ ok: false, error: 'Timed out waiting for the app' })
    }, CALL_TIMEOUT_MS)
    pending.set(callId, { resolve, timer, windowId: client.windowId })
    const request: McpCallRequest = { callId, name, args }
    client.contents.send('mcp:call', request)
  })
}

function rpcDeps(client: McpClient): RpcDeps {
  return {
    tools: TOOLS,
    botTools: BOT_TOOLS,
    handlers: botHandlers,
    serverInfo: { name: MCP_SERVER_NAME, version: app.getVersion() },
    instructions: INSTRUCTIONS,
    supportedVersions: SUPPORTED_VERSIONS,
    callRenderer: (name, args) => callRenderer(client, name, args)
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function clientFor(req: IncomingMessage): McpClient | undefined {
  const actual = Buffer.from(req.headers.authorization ?? '')
  return [...clients.values(), ...botTurns.values()].find((client) => {
    const expected = Buffer.from(`Bearer ${client.token}`)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = req.url?.split('?')[0]
  if (path !== '/mcp' && path !== '/bot/policy') {
    res.writeHead(404).end()
    return
  }
  const client = clientFor(req)
  if (!client) {
    res.writeHead(401).end()
    return
  }
  if (path === '/bot/policy') {
    if (!client.bot || req.method !== 'POST') {
      res.writeHead(403).end()
      return
    }
    // A throw here becomes the 500 in startMcpServer: curl --fail then makes the hook exit 2, blocking the tool.
    const decision = botHandlers!.policy(client.windowId, JSON.parse(await readBody(req)))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(decision))
    return
  }
  // No server-initiated stream and no sessions to end.
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end()
    return
  }

  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
    return
  }

  const answer = await handleBody(body, client, rpcDeps(client))
  if (answer === null) {
    res.writeHead(202).end()
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(answer))
}

let portPromise: Promise<number> | null = null

/**
 * Per-window config files (`mcp-<id>`, `mcp-gemini-<id>`, `mcp-codex-<id>`) don't outlive a launch;
 * a crash can leave them behind. `mcp-bot-<id>.json` is no longer written (the bot's config is
 * inline), but older versions left them.
 */
async function removeStaleConfigs(): Promise<void> {
  const dir = app.getPath('userData')
  const names = await readdir(dir)
  await Promise.all(
    names
      .filter((n) => n === 'global-claude-mcp.json' || /^mcp-(bot-|gemini-|codex-)?\d+\.json$/.test(n))
      .map((n) => rm(join(dir, n), { force: true }))
  )
}

function startMcpServer(): Promise<number> {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(err))
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', async () => {
      try {
        await removeStaleConfigs()
        resolve((server.address() as AddressInfo).port)
      } catch (err) {
        reject(err)
      }
    })
  })
}

/** Writes this window's --mcp-config file, with a token that identifies the window. */
async function configPathFor(contents: WebContents): Promise<string> {
  portPromise ??= startMcpServer().catch((err) => {
    portPromise = null
    throw err
  })
  const port = await portPromise
  const existing = clients.get(contents.id)
  if (existing) {
    await existing.written
    return existing.configPath
  }
  const token = randomBytes(32).toString('hex')
  const configPath = join(app.getPath('userData'), `mcp-${contents.id}.json`)
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  }
  const written = writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  clients.set(contents.id, { windowId: contents.id, contents, token, configPath, written, bot: false })
  try {
    await written
  } catch (err) {
    clients.delete(contents.id)
    throw err
  }
  return configPath
}

/** Everything a non-Claude CLI needs to reach this window's MCP server. */
async function accessFor(contents: WebContents): Promise<McpAccess> {
  const configPath = await configPathFor(contents)
  const client = clients.get(contents.id)
  if (!client || contents.isDestroyed()) throw new Error('The app window is not open')
  const port = await portPromise!
  const url = `http://127.0.0.1:${port}/mcp`
  // Written once per window, like the Claude config. Gemini reads MCP servers from a
  // settings file and trusts this one's tools, the equivalent of --allowedTools mcp__trek-dev.
  // Codex runs a helper command that prints the headers file, so its token is in no env or argv.
  client.geminiWritten ??= (async () => {
    const headers = { Authorization: `Bearer ${client.token}` }
    const geminiSettingsPath = join(app.getPath('userData'), `mcp-gemini-${contents.id}.json`)
    const codexHeadersPath = join(app.getPath('userData'), `mcp-codex-${contents.id}.json`)
    const settings = { mcpServers: { [MCP_SERVER_NAME]: { httpUrl: url, headers, trust: true } } }
    await writeFile(geminiSettingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
    await writeFile(codexHeadersPath, JSON.stringify(headers), { mode: 0o600 })
    return { geminiSettingsPath, codexHeadersPath }
  })()
  let written: { geminiSettingsPath: string; codexHeadersPath: string }
  try {
    written = await client.geminiWritten
  } catch (err) {
    client.geminiWritten = undefined
    throw err
  }
  // The window may have closed (and had its files removed) while we were writing.
  if (contents.isDestroyed()) {
    for (const path of Object.values(written)) void rm(path, { force: true }).catch((err) => console.error(err))
    throw new Error('The app window is not open')
  }
  return {
    configPath,
    url,
    token: client.token,
    geminiSettingsPath: written.geminiSettingsPath,
    codexHeadersHelper: codexHeadersHelper(written.codexHeadersPath, process.platform)
  }
}

export interface BotMcpAccess {
  port: number
}

/** Starts the MCP server if need be, for the bot's turns. Tokens are per turn: see openBotTurn. */
export async function botMcpAccess(contents: WebContents): Promise<BotMcpAccess> {
  portPromise ??= startMcpServer().catch((err) => {
    portPromise = null
    throw err
  })
  const port = await portPromise
  if (contents.isDestroyed()) throw new Error('The app window is not open')
  return { port }
}

export interface BotTurnToken {
  token: string
  /** Revokes the token. Safe to call more than once. */
  close: () => void
}

/**
 * A fresh token for one bot turn, valid until `close` (when the turn settles) or the window closes.
 * Between turns no bot token works at all, so a call with none running gets a 401.
 */
export function openBotTurn(contents: WebContents): BotTurnToken {
  // A window closed by now has been released, and nothing would release a new token.
  if (contents.isDestroyed()) throw new Error('The app window is not open')
  const token = randomBytes(32).toString('hex')
  botTurns.set(token, { windowId: contents.id, contents, token, bot: true })
  return { token, close: () => void botTurns.delete(token) }
}

/** Reads the renderer's session state for the bot's change check. Not an MCP tool. */
export async function readBotSnapshot(contents: WebContents): Promise<unknown> {
  if (contents.isDestroyed()) throw new Error('The app window is not open')
  const response = await callRenderer({ windowId: contents.id, contents, token: '', bot: true }, 'bot_snapshot', {})
  if (!response.ok) throw new Error(response.error ?? 'Unknown error')
  return response.result
}

/** Revokes a closed window's token and fails the calls still waiting on it. */
export function releaseMcpWindow(windowId: number): void {
  for (const [callId, entry] of pending) {
    if (entry.windowId !== windowId) continue
    pending.delete(callId)
    clearTimeout(entry.timer)
    entry.resolve({ ok: false, error: 'The app window was closed' })
  }
  const session = clients.get(windowId)
  if (session) {
    clients.delete(windowId)
    void rm(session.configPath, { force: true }).catch((err) => console.error(err))
  }
  for (const [token, client] of botTurns) if (client.windowId === windowId) botTurns.delete(token)
  for (const name of [`mcp-gemini-${windowId}.json`, `mcp-codex-${windowId}.json`]) {
    void rm(join(app.getPath('userData'), name), { force: true }).catch((err) => console.error(err))
  }
}

export function registerMcpHandlers(): void {
  ipcMain.handle('mcp:configPath', (event) => configPathFor(event.sender))
  ipcMain.handle('mcp:access', (event) => accessFor(event.sender))

  ipcMain.on('mcp:result', (_event, callId: string, response: McpCallResponse) => {
    const entry = pending.get(callId)
    if (!entry) return
    pending.delete(callId)
    clearTimeout(entry.timer)
    entry.resolve(response)
  })
}
