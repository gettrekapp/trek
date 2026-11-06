// The app-wide trek-server (protocol v2) list: entries in userData/app-servers.json,
// tokens in safeStorage. The renderer can set a token and ask whether one is set;
// no IPC call ever returns one. Main reads tokens for the relay and for Test only.
import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSecretStore } from './secrets'
import { parseAppServers, validateServerInput, type AppServer } from './appServersRules'
import { globalSocketFactory } from '../shared/client/index.ts'
import { probeServer } from './appServerProbe'
import { closeForServer } from './v2relay'
import type { AppServerInfo, AppServerTest } from '../shared/types'

const FILE_NAME = 'app-servers.json'

const tokens = createSecretStore('app-server-tokens.json')

let servers: AppServer[] | null = null

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function loaded(): AppServer[] {
  if (servers) return servers
  try {
    servers = parseAppServers(JSON.parse(readFileSync(filePath(), 'utf8')))
  } catch {
    servers = []
  }
  return servers
}

/** Every write goes through this chain, so concurrent saves never interleave. */
let writeChain: Promise<unknown> = Promise.resolve()

function persist(): Promise<void> {
  const snapshot = JSON.stringify(loaded(), null, 2)
  const run = writeChain.then(async () => {
    const path = filePath()
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, snapshot, 'utf8')
    await rename(temp, path)
  })
  writeChain = run.catch(() => undefined)
  return run
}

export function listAppServers(): AppServer[] {
  return loaded().map((s) => ({ ...s }))
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
  const isNew = id === undefined || id === null || id === ''
  const existing = isNew ? null : requireKnown(id)
  const entryId = existing ? existing.id : randomUUID()
  if (token) await tokens.set(entryId, token)
  let entry: AppServer
  if (existing) {
    existing.name = valid.name
    existing.url = valid.url
    entry = existing
  } else {
    entry = { id: entryId, ...valid }
    loaded().push(entry)
  }
  await persist()
  return info(entry)
}

async function setToken(id: unknown, token: unknown): Promise<void> {
  const server = requireKnown(id)
  if (token !== null && token !== undefined && typeof token !== 'string') throw new Error('token must be a string')
  await tokens.set(server.id, token ? token : null)
}

async function remove(id: unknown): Promise<void> {
  const key = requireId(id)
  const list = loaded()
  const index = list.findIndex((s) => s.id === key)
  if (index >= 0) list.splice(index, 1)
  closeForServer(key)
  await tokens.set(key, null)
  if (index >= 0) await persist()
}

/** One-shot v2 connection check through the 3a SDK; the connection is always closed. */
async function test(id: unknown): Promise<AppServerTest> {
  const server = requireKnown(id)
  const token = await tokens.get(server.id)
  if (!token) return { status: 'needs-auth', message: 'No token set' }

  return probeServer({ url: server.url, token, createSocket: globalSocketFactory, clientVersion: app.getVersion() })
}

export function registerAppServerHandlers(): void {
  ipcMain.handle('appServers:list', async () => Promise.all(loaded().map(info)))
  ipcMain.handle('appServers:save', (_event, input: unknown) => save(input))
  ipcMain.handle('appServers:setToken', (_event, id: unknown, token: unknown) => setToken(id, token))
  ipcMain.handle('appServers:remove', (_event, id: unknown) => remove(id))
  ipcMain.handle('appServers:test', (_event, id: unknown) => test(id))
}
