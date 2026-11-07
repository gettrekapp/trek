// The app-wide trek-server (protocol v2) list: entries in userData/app-servers.json,
// tokens in safeStorage. The renderer can set a token and ask whether one is set;
// no IPC call ever returns one. Main reads tokens for the relay, for Test and for
// its own connections (serverLinks.ts), whose statuses every window hears through
// `appServers:changed` (a snapshot with `hasToken`, never a token).
import { app, BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createSecretStore, writeFileAtomic } from './secrets'
import { parseAppServers, shouldClearToken, validateServerInput, type AppServer } from './appServersRules'
import { SERVER_REMOVED_MESSAGE, globalSocketFactory } from '../shared/client/index.ts'
import { probeServer } from './appServerProbe'
import { closeForServer } from './v2relay'
import { createServerLinks, type ServerLinks } from './serverLinks'
import type { AppServerInfo, AppServersChanged, AppServerTest } from '../shared/types'

const FILE_NAME = 'app-servers.json'

const tokens = createSecretStore('app-server-tokens.json')

let servers: AppServer[] | null = null
/** Main's own connections, from registerAppServerHandlers on */
let links: ServerLinks | null = null

function broadcast(snapshot: AppServersChanged): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('appServers:changed', snapshot)
  }
}

/**
 * After every change to the list or a token: main's connections follow, and
 * every window hears of it, before the change's own IPC reply.
 */
function linksFollow(): Promise<void> {
  return links?.sync() ?? Promise.resolve()
}

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/** A missing file is an empty list; an unreadable or corrupt one is set aside (not overwritten) and the list starts empty. */
function loaded(): AppServer[] {
  if (servers) return servers
  const path = filePath()
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(raw)) throw new Error('not a list')
    servers = parseAppServers(raw)
  } catch (err) {
    servers = []
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const aside = `${path}.corrupt-${Date.now()}`
      try {
        renameSync(path, aside)
        console.warn(`trek: ${FILE_NAME} could not be read (${err instanceof Error ? err.message : String(err)}); moved it to ${aside}`)
      } catch (renameErr) {
        console.warn(`trek: ${FILE_NAME} could not be read, nor moved aside`, err, renameErr)
      }
    }
  }
  return servers
}

/** Every write goes through this chain, so concurrent saves never interleave. */
let writeChain: Promise<unknown> = Promise.resolve()

function persist(): Promise<void> {
  const snapshot = JSON.stringify(loaded(), null, 2)
  const run = writeChain.then(() => writeFileAtomic(filePath(), snapshot))
  writeChain = run.catch(() => undefined)
  return run
}

export function getAppServer(id: string): AppServer | undefined {
  const found = loaded().find((s) => s.id === id)
  return found ? { ...found } : undefined
}

/** Main-only: never return this over IPC. */
export async function getAppServerToken(id: string): Promise<string | null> {
  return tokens.get(id)
}

async function info(server: AppServer): Promise<AppServerInfo> {
  return { ...server, hasToken: !!(await tokens.get(server.id)) }
}

function requireId(id: unknown): string {
  if (typeof id !== 'string' || !id) throw new Error('id is required')
  return id
}

function requireKnown(id: unknown): AppServer {
  const server = loaded().find((s) => s.id === requireId(id))
  if (!server) throw new Error('Unknown server')
  return server
}

async function save(input: unknown): Promise<AppServerInfo> {
  if (!input || typeof input !== 'object') throw new Error('server details are required')
  const { id, name, url, token } = input as Record<string, unknown>
  const valid = validateServerInput({ name, url })
  if (token !== undefined && token !== null && typeof token !== 'string') throw new Error('token must be a string')
  const tokenGiven = typeof token === 'string' && token !== ''
  const isNew = id === undefined || id === null || id === ''
  const before = isNew ? null : { ...requireKnown(id) }
  const entryId = before ? before.id : randomUUID()
  const urlChanged = !!before && before.url !== valid.url

  // The in-memory change and the token write start in the same synchronous step:
  // the secret store runs gets after queued sets, so a relay open that reads the
  // new URL also reads the new token, and one that read the old URL sees the URL
  // change after its token read and refuses (v2relay). No token crosses origins.
  const list = loaded()
  let entry: AppServer
  if (before) {
    entry = list.find((s) => s.id === entryId)!
    entry.name = valid.name
    entry.url = valid.url
  } else {
    entry = { id: entryId, ...valid }
    list.push(entry)
  }
  const rollback = (): void => {
    if (before) {
      entry.name = before.name
      entry.url = before.url
    } else {
      const index = list.indexOf(entry)
      if (index >= 0) list.splice(index, 1)
    }
  }

  // A stored token never follows the URL to another origin (unless this call brings its own).
  try {
    if (tokenGiven) await tokens.set(entryId, token as string)
    else if (before && shouldClearToken(before.url, valid.url, false)) await tokens.set(entryId, null)
  } catch (err) {
    // The token write failed, so the old token (if any) is still the stored one: back to the old URL.
    rollback()
    throw err
  }

  // Removed while the token was written: it stays removed, and so does its token.
  if (before && !list.includes(entry)) {
    await tokens.set(entryId, null)
    throw new Error(SERVER_REMOVED_MESSAGE)
  }
  try {
    await persist()
  } catch (err) {
    // Roll back the in-memory change, and never leave a new token on the old URL
    // (the clear is queued in the same step as the URL goes back).
    const clear = tokenGiven && (!before || shouldClearToken(before.url, valid.url, false))
    rollback()
    if (clear) await tokens.set(entryId, null).catch(() => undefined)
    throw err
  }
  // Open relay sockets still point at the old URL; the SDK reconnects to the new one.
  if (urlChanged) closeForServer(entryId, 'server address changed')
  await linksFollow()
  return info(entry)
}

async function setToken(id: unknown, token: unknown): Promise<void> {
  const server = requireKnown(id)
  if (token !== null && token !== undefined && typeof token !== 'string') throw new Error('token must be a string')
  await tokens.set(server.id, token ? token : null)
  await linksFollow()
}

async function remove(id: unknown): Promise<void> {
  const key = requireId(id)
  const list = loaded()
  const index = list.findIndex((s) => s.id === key)
  const [gone] = index >= 0 ? list.splice(index, 1) : []
  closeForServer(key, 'server removed')
  try {
    await tokens.set(key, null)
    if (!gone) return
    try {
      await persist()
    } catch (err) {
      // Still on disk, so back in the list (without its token).
      list.splice(Math.min(index, list.length), 0, gone)
      throw err
    }
  } finally {
    await linksFollow()
  }
}

/** One-shot v2 connection check through the 3a SDK; the connection is always closed. */
async function test(id: unknown): Promise<AppServerTest> {
  const server = requireKnown(id)
  const token = await tokens.get(server.id)
  if (!token) return { status: 'needs-auth', message: 'No token set' }

  return probeServer({ url: server.url, token, createSocket: globalSocketFactory, clientVersion: app.getVersion() })
}

/** Quit: main's connections close for good. */
export function closeServerLinks(): void {
  links?.close()
}

export function registerAppServerHandlers(): void {
  links = createServerLinks({
    entries: () => loaded().map((s) => ({ ...s })),
    token: (id) => tokens.get(id),
    createSocket: globalSocketFactory,
    clientVersion: app.getVersion(),
    changed: broadcast
  })
  const ready = links.sync()
  // A token added on the server, or the server upgraded, has no event here: a window coming
  // to the front retries the connections stuck in needs-auth or incompatible (throttled).
  app.on('browser-window-focus', () => links?.retryStuck())
  ipcMain.handle('appServers:links', async () => {
    await ready
    return links!.snapshot()
  })
  ipcMain.handle('appServers:list', async () => Promise.all(loaded().map(info)))
  ipcMain.handle('appServers:save', (_event, input: unknown) => save(input))
  ipcMain.handle('appServers:setToken', (_event, id: unknown, token: unknown) => setToken(id, token))
  ipcMain.handle('appServers:remove', (_event, id: unknown) => remove(id))
  ipcMain.handle('appServers:test', (_event, id: unknown) => test(id))
}
