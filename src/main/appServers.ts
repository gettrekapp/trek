// The app-wide trek-server (protocol v2) list: entries in userData/app-servers.json,
// tokens in safeStorage, and first, the synthetic Local entry (localServer.ts): never
// persisted, never edited or removed, its URL following the running local server and
// its token read from local.json by main. The renderer can set a token and ask whether
// one is set; no IPC call ever returns one. Main reads tokens for the relay, for Test and for
// its own connections (serverLinks.ts), whose statuses every window hears through
// `appServers:changed` (a snapshot with `hasToken`, never a token).
import { app, BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createSecretStore, writeFileAtomic } from './secrets'
import {
  addedServerName,
  mayAdoptToken,
  parseAppServers,
  reinsertAt,
  rejectDuplicateServer,
  rejectLocalServerUrl,
  shouldClearToken,
  shouldRetryAfterTest,
  testTokenRefusal,
  validateServerInput,
  withRemoving,
  type AppServer,
  type RemovingEntry
} from './appServersRules'
import { SERVER_REMOVED_MESSAGE, globalSocketFactory } from '../shared/client/index.ts'
import { probeServer } from './appServerProbe'
import { closeForServer } from './v2relay'
import { checkLocalServer, localEntry, localServerUrl, localToken, onLocalServerChanged } from './localServer'
import { LOCAL_ENTRY_ID } from './localServerRules'
import { createServerLinks, type ServerLinks, type ServerLinksDeps } from './serverLinks'
import type { RegisteredServer } from '../shared/client/index.ts'
import type { AppServerInfo, AppServersChanged, AppServerTest } from '../shared/types'

const FILE_NAME = 'app-servers.json'

const tokens = createSecretStore('app-server-tokens.json')

let servers: AppServer[] | null = null
/**
 * Entries a remove has taken out of the list but not yet off the disk. Until
 * then they are not "removed" to a window: main's snapshots still list them
 * and the relay refuses them only for now, so a remove whose write fails (and
 * puts the entry back) never leaves a window on "Server removed" for good.
 */
const removing = new Map<string, RemovingEntry>()
/** Main's own connections, from registerAppServerHandlers on */
let links: ServerLinks | null = null
/** Hears every change of the list (a rename relabels the attention entries) */
let listChanged: (() => void) | null = null

/** To every window; one closing meanwhile (or failing the send) never stops the rest. */
function broadcast(snapshot: AppServersChanged): void {
  listChanged?.()
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('appServers:changed', snapshot)
    } catch (err) {
      console.warn('trek: could not send appServers:changed to a window', err)
    }
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

/** The list as the app shows it: Local first (unless the supervisor is off), then the saved entries. */
function listed(): AppServer[] {
  const local = localEntry()
  return local ? [local, ...loaded()] : loaded()
}

export function getAppServer(id: string): AppServer | undefined {
  const found = listed().find((s) => s.id === id)
  return found ? { ...found } : undefined
}

/** A remove of the entry is in progress (see `removing`). */
export function isAppServerRemoving(id: string): boolean {
  return removing.has(id)
}

/** The list as main's connections and their snapshots see it: with the entries a remove has not yet written. */
function linkEntries(): AppServer[] {
  const local = localEntry()
  const saved = withRemoving(loaded(), removing.values())
  return local ? [local, ...saved] : saved
}

/** Main-only: never return this over IPC. Local's is read from local.json (localServer.ts). */
export async function getAppServerToken(id: string): Promise<string | null> {
  return id === LOCAL_ENTRY_ID ? localToken() : tokens.get(id)
}

async function info(server: AppServer): Promise<AppServerInfo> {
  const { local: _local, ...entry } = server
  return { ...entry, hasToken: !!(await getAppServerToken(server.id)) }
}

/** Save, setToken and remove refuse the Local entry: the supervisor owns it. */
function refuseLocal(id: unknown, what: string): void {
  if (id === LOCAL_ENTRY_ID) throw new Error(`The Local server cannot be ${what}`)
}

function requireId(id: unknown): string {
  if (typeof id !== 'string' || !id) throw new Error('id is required')
  return id
}

function requireKnown(id: unknown): AppServer {
  const server = listed().find((s) => s.id === requireId(id))
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
  refuseLocal(id, 'edited')
  const before = isNew ? null : { ...requireKnown(id) }
  rejectDuplicateServer(loaded(), valid.url, before ? before.id : null)
  rejectLocalServerUrl(valid.url, localServerUrl())
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

  // Whatever happens from here (a rolled-back change included), main's connections follow
  // the list as it ends up.
  try {
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
  } finally {
    await linksFollow()
  }
  return info(entry)
}

async function setToken(id: unknown, token: unknown): Promise<void> {
  refuseLocal(id, 'given a token')
  const server = requireKnown(id)
  if (token !== null && token !== undefined && typeof token !== 'string') throw new Error('token must be a string')
  await tokens.set(server.id, token ? token : null)
  await linksFollow()
}

async function remove(id: unknown): Promise<void> {
  const key = requireId(id)
  refuseLocal(key, 'removed')
  const list = loaded()
  const index = list.findIndex((s) => s.id === key)
  const [gone] = index >= 0 ? list.splice(index, 1) : []
  if (gone) {
    // Until it is off the disk, the broadcasts (a status change meanwhile included) still list it.
    removing.set(key, { entry: gone, index })
    // Main's own connection stops now, not reconnecting with the cached token meanwhile;
    // if the remove fails, the sync below brings it back.
    links?.drop(key)
  }
  closeForServer(key, 'server removed')
  try {
    // An unknown id still has any stray token cleared, and nothing to write.
    await tokens.set(key, null)
    if (gone) await persist()
  } catch (err) {
    // The token clear or the write failed: still on disk, so back in the list (with its
    // token, if the clear is what failed).
    if (gone) reinsertAt(list, index, gone)
    throw err
  } finally {
    // Back in the list, or gone for good: in the same step, so no snapshot misses or doubles it.
    if (gone) removing.delete(key)
    await linksFollow()
  }
}

/**
 * One-shot v2 connection check through the 3a SDK; the connection is always closed.
 * The token goes only to the URL the entry had when it was read: a save that
 * re-points the entry meanwhile (or a remove) refuses this Test instead.
 */
async function test(id: unknown): Promise<AppServerTest> {
  const { id: key, url } = requireKnown(id)
  const token = await getAppServerToken(key)
  const refused = testTokenRefusal(url, getAppServer(key))
  if (refused) return refused
  if (!token) return { status: 'needs-auth', message: 'No token set' }

  const result = await probeServer({ url, token, createSocket: globalSocketFactory, clientVersion: app.getVersion() })
  // The server takes this token now (added there, or the server upgraded): main's own
  // connection, if stuck in needs-auth or incompatible, reconnects at once, unthrottled;
  // unless the entry was re-pointed or is being removed while the probe ran.
  if (shouldRetryAfterTest(result, url, getAppServer(key), removing.has(key))) links?.retry(key)
  return result
}

/** The saved entries (not Local), for the importer's matching by origin. */
export function savedAppServers(): AppServer[] {
  return loaded().map((s) => ({ ...s }))
}

/**
 * Main-only (the importer): a new entry for a legacy server the user agreed to add, with the
 * v1 token carried over when one was stored for its origin (or none). Goes through Save's checks.
 */
export async function addAppServer(name: string, url: string, token: string | null): Promise<AppServerInfo> {
  // The file's name for the server is free text: Save's limit, or the URL's host.
  return save({ name: addedServerName(name, url), url, token })
}

/**
 * Main-only (the importer): stores `token` for a saved entry that has none, so a legacy server's
 * token follows its project. `url` is the address the token was matched to (adoptableToken): an
 * entry re-pointed meanwhile gets nothing. An entry's own token is never replaced. True when stored.
 */
export async function adoptAppServerToken(id: string, url: string, token: string): Promise<boolean> {
  refuseLocal(id, 'given a token')
  // The URL check and the store's set-if-absent are queued in the same synchronous step, as Save
  // does: a token the user set (or another adoption) queued before it is never overwritten, and a
  // Save that re-points the entry or a remove queued after it clears it.
  if (!mayAdoptToken(id, getAppServer(id), url)) return false
  const stored = await tokens.setIfAbsent(id, token)
  if (stored) await linksFollow()
  return stored
}

/** Quit: main's connections close for good. */
export function closeServerLinks(): void {
  links?.close()
}

/** Main's own connection to the entry (attention's dismiss goes on it); never handed to a window. */
export function serverLink(id: string): RegisteredServer | undefined {
  return links?.get(id)
}

/** `hooks`: the attention aggregator hears of each connection made and gone, and of each list change. */
export function registerAppServerHandlers(
  hooks: Pick<ServerLinksDeps, 'linked' | 'unlinked'> & { listChanged?: () => void } = {}
): void {
  listChanged = hooks.listChanged ?? null
  links = createServerLinks({
    entries: linkEntries,
    token: getAppServerToken,
    createSocket: globalSocketFactory,
    clientVersion: app.getVersion(),
    changed: broadcast,
    linked: (id, registered) => {
      // main's connection to Local going down is the first sign of a restart or crash elsewhere.
      if (id === LOCAL_ENTRY_ID) {
        registered.connection.on('status', ({ status }) => {
          if (status !== 'connected') checkLocalServer()
        })
      }
      hooks.linked?.(id, registered)
    },
    unlinked: hooks.unlinked
  })
  const ready = links.sync()
  // Local's server changed (started, stopped, restarted): main's connection follows its URL and
  // token, every window hears the new status, and relay sockets still on the old URL close.
  let localUrl = localEntry()?.url
  onLocalServerChanged(() => {
    const url = localEntry()?.url
    if (url !== localUrl) closeForServer(LOCAL_ENTRY_ID, 'local server restarted')
    localUrl = url
    void linksFollow()
  })
  // A token added on the server, or the server upgraded, has no event here: a window coming
  // to the front retries the connections stuck in needs-auth or incompatible (throttled).
  app.on('browser-window-focus', () => {
    links?.retryStuck()
    checkLocalServer()
  })
  ipcMain.handle('appServers:links', async () => {
    await ready
    return links!.snapshot()
  })
  ipcMain.handle('appServers:list', async () => Promise.all(listed().map(info)))
  ipcMain.handle('appServers:save', (_event, input: unknown) => save(input))
  ipcMain.handle('appServers:setToken', (_event, id: unknown, token: unknown) => setToken(id, token))
  ipcMain.handle('appServers:remove', (_event, id: unknown) => remove(id))
  ipcMain.handle('appServers:test', (_event, id: unknown) => test(id))
}
