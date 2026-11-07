import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { OFF_VIEW, type BotAttach, type BotEvent, type BotView, type TrekSnapshot } from '../shared/bot'
import { commandProblem, consentEntry } from '../host/bot/consent.ts'
import { startHeartbeat } from '../host/bot/heartbeat.ts'
import { acquireBotLock } from '../host/bot/lock.ts'
import {
  createBotFolder, defaultBotFolder, isDirectory, looksLikeBotFolder, readConfig, readEvents
} from '../host/bot/memory.ts'
import { BotRunner } from '../host/bot/runner.ts'
import { killAllTurnsNow, runTurn } from '../host/bot/turnProcess.ts'
import { isConsented, recordConsent } from './botConsent'
import { BOT_SECRET_FILES } from './botSecretFiles'
import { botMcpAccess, readBotSnapshot, releaseMcpWindow, setBotMcpHandlers, type BotMcpAccess } from './mcp'

interface BoundBot {
  key: string
  folder: string
  /** `folder` with symlinks resolved, for telling whether two bots share one. */
  folderId: string
  runner: BotRunner
  stopHeartbeat: () => void
  releaseLock: () => void
  attach: BotAttach
}

const EVENT_HISTORY = 500
const QUIT_WAIT_MS = 2000
const bots = new Map<number, BoundBot>()
/** Runners still finishing, by folderId. A new runner on that folder waits, or the two would overwrite its state. */
const stopping = new Map<string, Promise<void>>()
/** The last step queued for each window, so that starting and stopping its bot never overlap. */
const windowQueues = new Map<number, Promise<void>>()
/** What each window last asked to attach. Consent is always given to this, never to values sent with the click. */
const requested = new Map<number, BotAttach>()
let quitting = false

const secretPaths = (): string[] => BOT_SECRET_FILES.map((n) => join(app.getPath('userData'), n))

function sendView(contents: WebContents, view: BotView): void {
  if (!contents.isDestroyed()) contents.send('bot:view', view)
}

function sendEvent(contents: WebContents, event: BotEvent): void {
  if (!contents.isDestroyed()) contents.send('bot:event', event)
}

/** Blocks the tool if the app can't answer: curl --fail plus exit 2 fails closed. */
function hookSettings(port: number): string {
  const command = `curl -sS --fail --max-time 10 -X POST -H "Authorization: Bearer $TREK_BOT_TOKEN" --data-binary @- http://127.0.0.1:${port}/bot/policy || exit 2`
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] }
  })
}

function folderIdOf(folder: string): string {
  try {
    return realpathSync(folder)
  } catch {
    return resolve(folder)
  }
}

/** Runs `step` after everything already queued for the window, whether that succeeded or not. */
function inWindowOrder<T>(windowId: number, step: () => Promise<T>): Promise<T> {
  const result = (windowQueues.get(windowId) ?? Promise.resolve()).then(step)
  const tail = result.then(
    () => {},
    () => {}
  )
  windowQueues.set(windowId, tail)
  void tail.then(() => {
    if (windowQueues.get(windowId) === tail) windowQueues.delete(windowId)
  })
  return result
}

/** Only call from a step in the window's queue. */
async function teardown(windowId: number): Promise<void> {
  const bot = bots.get(windowId)
  if (!bot) return
  bots.delete(windowId)
  bot.stopHeartbeat()
  const stopped = bot.runner.stop()
  stopping.set(bot.folderId, stopped)
  try {
    await stopped
  } finally {
    bot.releaseLock()
    if (stopping.get(bot.folderId) === stopped) stopping.delete(bot.folderId)
  }
}

/**
 * For quitting, once it can no longer be cancelled. Windows closing have started stopping their bots,
 * but the SIGKILL that follows their SIGTERM wouldn't outlive the app, so it happens now instead.
 */
export async function stopAllBots(): Promise<void> {
  quitting = true
  for (const bot of bots.values()) void bot.runner.stop().catch((err) => console.error(err))
  killAllTurnsNow()
  for (const windowId of [...bots.keys()]) void inWindowOrder(windowId, () => teardown(windowId)).catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled([...windowQueues.values()]),
    new Promise((done) => {
      timer = setTimeout(done, QUIT_WAIT_MS)
    })
  ])
  clearTimeout(timer)
}

/** Stops the bot when its window closes. Part of the window's cleanup. */
export function releaseBotWindow(windowId: number): void {
  requested.delete(windowId)
  void inWindowOrder(windowId, () => teardown(windowId))
    .catch((err) => console.error(err))
    // An attach that was under way when the window closed may have made a new bot token.
    .finally(() => releaseMcpWindow(windowId))
}

function errorView(folder: string, reason: string): BotView {
  return { ...OFF_VIEW, phase: 'error', folder, reason, decision: `Bot stopped: ${reason}` }
}

function missingView(folder: string): BotView {
  return { ...errorView(folder, `The bot's folder is missing: ${folder}`), folderMissing: true }
}

function inUseView(folder: string, reason: string): BotView {
  return { ...errorView(folder, reason), folderInUse: true }
}

/** No alert, like the consent view: this can be the first thing a shared project shows on opening. */
function badCommandView(folder: string, reason: string): BotView {
  return { ...OFF_VIEW, phase: 'error', folder, reason }
}

function consentView(folder: string, command: string): BotView {
  return { ...OFF_VIEW, needsConsent: true, folder, command }
}

const folderFor = (request: BotAttach): string => request.folder ?? defaultBotFolder(request.filePath)

/** A command that breaks the rule is never recorded: nothing could ever use the entry. */
async function consentTo(request: BotAttach, folder: string): Promise<void> {
  if (commandProblem(request.claudeCommand)) return
  await recordConsent(consentEntry(request.filePath, folder, request.claudeCommand))
}

function requestOf(windowId: number): BotAttach {
  const request = requested.get(windowId)
  if (!request) throw new Error('This window has no saved project.')
  return request
}

function bind(
  contents: WebContents,
  windowId: number,
  request: BotAttach,
  place: { key: string; folder: string; folderId: string },
  access: BotMcpAccess,
  releaseLock: () => void
): void {
  const { folder } = place
  const bound: BoundBot = {
    ...place,
    attach: request,
    releaseLock,
    stopHeartbeat: () => {},
    runner: new BotRunner({
      folder,
      secretPaths: secretPaths(),
      now: Date.now,
      newSessionId: randomUUID,
      snapshot: async () => (await readBotSnapshot(contents)) as TrekSnapshot,
      runTurn: (turn, onEvent) =>
        runTurn(
          {
            command: bound.attach.claudeCommand.trim().split(/\s+/),
            cwd: folder,
            prompt: turn.prompt,
            systemPrompt: turn.systemPrompt,
            sessionId: turn.sessionId,
            resume: turn.resume,
            mcpConfig: access.configPath,
            settings: hookSettings(access.port),
            addDirs: bound.attach.repoPaths.filter((p) => existsSync(p)),
            env: { TREK_BOT_TOKEN: access.token },
            timeoutMs: turn.timeoutMs
          },
          onEvent
        ),
      onView: (view) => sendView(contents, view),
      onEvent: (event) => sendEvent(contents, event),
      // Called from inside the runner, so stopping it has to wait until that call has returned.
      onFolderMissing: () => {
        setImmediate(() => {
          void inWindowOrder(windowId, async () => {
            if (bots.get(windowId) !== bound) return
            await teardown(windowId)
            sendView(contents, missingView(folder))
          }).catch((err) => console.error(err))
        })
      }
    })
  }
  bots.set(windowId, bound)
  bound.runner.start()
  bound.stopHeartbeat = startHeartbeat(
    () => readConfig(folder).intervalMinutes, // falls back to the default if the file is gone
    // A beat finds a removed or moved folder itself, and reports it through onFolderMissing.
    () => void bound.runner.beat(),
    (at) => {
      if (bots.get(windowId) === bound) bound.runner.setNextBeat(at)
    }
  )
}

async function startBot(
  contents: WebContents,
  windowId: number,
  request: BotAttach,
  key: string,
  folder: string
): Promise<void> {
  const access = await botMcpAccess(contents)
  const folderId = folderIdOf(folder)
  for (let done = stopping.get(folderId); done; done = stopping.get(folderId)) await done
  // Nothing below awaits until the bot is in `bots`, so another window can't claim the folder meanwhile.
  if (contents.isDestroyed() || quitting) return
  if (!isDirectory(folder)) {
    sendView(contents, missingView(folder))
    return
  }
  if ([...bots.values()].some((bot) => bot.folderId === folderId)) {
    sendView(contents, inUseView(folder, `Another window's bot is using this folder: ${folder}`))
    return
  }
  createBotFolder(folder)
  const lock = acquireBotLock(folder)
  if (!lock.acquired) {
    const holder = lock.pid ? ` (process ${lock.pid})` : ''
    const reason = `Another copy of Trek${holder} is using this folder: ${folder}. If none is, delete state/lock in that folder.`
    sendView(contents, inUseView(folder, reason))
    return
  }
  try {
    bind(contents, windowId, request, { key, folder, folderId }, access, lock.release)
  } catch (err) {
    lock.release()
    throw err
  }
}

async function attach(contents: WebContents, windowId: number, request: BotAttach | null): Promise<void> {
  if (contents.isDestroyed()) return
  if (request) requested.set(windowId, request)
  else requested.delete(windowId)
  if (!request?.enabled) {
    await teardown(windowId)
    sendView(contents, OFF_VIEW)
    return
  }
  const folder = folderFor(request)
  // Both come before the running bot is reused, since its next turn would use the changed command.
  const problem = commandProblem(request.claudeCommand)
  if (problem) {
    await teardown(windowId)
    sendView(contents, badCommandView(folder, problem))
    return
  }
  if (!(await isConsented(consentEntry(request.filePath, folder, request.claudeCommand)))) {
    await teardown(windowId)
    sendView(contents, consentView(folder, request.claudeCommand.trim()))
    return
  }
  const key = `${request.filePath}\n${folder}`
  const existing = bots.get(windowId)
  if (existing?.key === key) {
    existing.attach = request
    sendView(contents, existing.runner.view())
    return
  }
  await teardown(windowId)
  try {
    await startBot(contents, windowId, request, key, folder)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sendView(contents, errorView(folder, `The bot could not start: ${message}`))
    throw err
  }
}

const TREK_TOOL_PREFIX = 'mcp__trek-dev__'

const hookAnswer = (allow: boolean, reason: string): object => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: allow ? 'allow' : 'deny',
    permissionDecisionReason: reason
  }
})

export function registerBotHandlers(): void {
  setBotMcpHandlers({
    // A throw reaches the 500 in startMcpServer, which blocks the tool, as does anything but allow here.
    policy: (windowId, hook) => {
      const tool = String(hook.tool_name ?? '')
      // Trek's own tools are checked once, by toolCall, when the call reaches the MCP server.
      // Checking here as well would spend an approval before the call it was for.
      if (tool.startsWith(TREK_TOOL_PREFIX)) return hookAnswer(true, 'Trek checks this call when it runs.')
      const bot = bots.get(windowId)
      const decision = bot
        ? bot.runner.checkTool(
            { tool, input: (hook.tool_input ?? {}) as Record<string, unknown> },
            typeof hook.cwd === 'string' ? hook.cwd : undefined
          )
        : { decision: 'deny', reason: 'The bot is not running' }
      return hookAnswer(decision.decision === 'allow', decision.reason)
    },
    toolCall: (windowId, name, args) => {
      const bot = bots.get(windowId)
      if (!bot) return { allowed: false, reason: 'The bot is not running' }
      const decision = bot.runner.checkTool({ tool: `${TREK_TOOL_PREFIX}${name}`, input: args })
      return { allowed: decision.decision === 'allow', reason: decision.reason }
    },
    requestApproval: (windowId, args) => {
      const bot = bots.get(windowId)
      if (!bot) throw new Error('The bot is not running')
      if (typeof args.tool !== 'string' || typeof args.reason !== 'string' || !args.input || typeof args.input !== 'object') {
        throw new Error('tool, input and reason are required')
      }
      return bot.runner.requestApproval(args.tool, args.input as Record<string, unknown>, args.reason)
    }
  })

  ipcMain.handle('bot:attach', (event, request: BotAttach | null) => {
    const contents = event.sender
    const windowId = contents.id
    return inWindowOrder(windowId, () => attach(contents, windowId, request))
  })
  ipcMain.handle('bot:allow', (event) => {
    const contents = event.sender
    const windowId = contents.id
    return inWindowOrder(windowId, async () => {
      const request = requested.get(windowId)
      if (!request?.enabled) return
      await consentTo(request, folderFor(request))
      await attach(contents, windowId, request)
    })
  })
  // Enable, Start new and Locate are this machine's user asking for the bot, so they count as consent.
  ipcMain.handle('bot:enable', (event) =>
    inWindowOrder(event.sender.id, async () => {
      const request = requestOf(event.sender.id)
      const folder = folderFor(request)
      if (!request.folder) createBotFolder(folder)
      await consentTo(request, folder)
    })
  )
  ipcMain.handle('bot:startNew', (event) =>
    inWindowOrder(event.sender.id, async () => {
      const request = requestOf(event.sender.id)
      const folder = defaultBotFolder(request.filePath)
      createBotFolder(folder)
      await consentTo(request, folder)
    })
  )
  ipcMain.handle('bot:locate', async (event): Promise<{ folder: string | null; error?: string }> => {
    // As of the click: a command that changes during the dialog asks again.
    const request = requestOf(event.sender.id)
    const win = BrowserWindow.fromWebContents(event.sender)!
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Locate the bot's folder",
      properties: ['openDirectory']
    })
    if (canceled) return { folder: null }
    const folder = filePaths[0]
    if (!looksLikeBotFolder(folder)) {
      return { folder: null, error: `That isn't a bot folder: ${folder} has no BOT.md or state folder.` }
    }
    await inWindowOrder(event.sender.id, () => consentTo(request, folder))
    return { folder }
  })
  ipcMain.handle('bot:events', (event): BotEvent[] => {
    const bot = bots.get(event.sender.id)
    return bot ? readEvents(bot.folder, EVENT_HISTORY) : []
  })
  ipcMain.handle('bot:setPaused', (event, paused: boolean) => bots.get(event.sender.id)?.runner.setPaused(paused))
  ipcMain.handle('bot:send', (event, text: string) => bots.get(event.sender.id)?.runner.send(text))
  ipcMain.handle('bot:decide', (event, id: string, approved: boolean) =>
    bots.get(event.sender.id)?.runner.decideApproval(id, approved)
  )
  ipcMain.handle('bot:openFolder', async (event) => {
    const bot = bots.get(event.sender.id)
    if (bot && isDirectory(bot.folder)) await shell.openPath(bot.folder)
  })
}
