// Hands the app's Linear and ElevenLabs keys and voice settings to the Local server, once per Local
// profile (phase 5b; the rules in integrationsHandoverRules.ts). Before 5b main kept them in
// userData (the keys encrypted with safeStorage, which the server cannot decrypt), and every window
// used them; now each server has its own, and the Local server starts with the app's. Main decrypts
// them and calls the same set-if-absent methods any client could, through its own connection with
// the Local token (never the renderer's). The old files are left as they were: the installed app and
// a dev build share this userData, and each hands over to its own Local profile.
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ServerConnection, globalSocketFactory } from '../shared/client/index.ts'
import { CAPABILITY } from '../shared/protocolV2.ts'
import { appSettings, updateAppSettings } from './appSettings'
import { createSecretStore, writeFileAtomic, type SecretRead, type SecretStore } from './secrets'
import { handOver, nothingToHandOver, readHandoverState, type HandoverState, type LegacyIntegrations } from './integrationsHandoverRules'
import { localProfileKey, localServerStatus, localServerUrl, localToken, onLocalServerChanged } from './localServer'

const STATE_FILE = 'integrations-handover.json'
const CONNECT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000

const statePath = (): string => join(app.getPath('userData'), STATE_FILE)

/** The state, or null (logged) when the file is there but cannot be read or parsed: that start does nothing. */
function readState(what: string): HandoverState | null {
  const { state, error } = readHandoverState(() => readFileSync(statePath(), 'utf8'))
  if (state) return state
  console.warn(`trek: ${statePath()} cannot be read; not trying to ${what} this start (nothing written)`, error)
  return null
}

function readLegacyVoice(): LegacyIntegrations['voice'] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(app.getPath('userData'), 'voice-settings.json'), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as LegacyIntegrations['voice']) : {}
  } catch {
    return {}
  }
}

const readSecret = (store: SecretStore): Promise<SecretRead> => store.read('apiKey').catch((): SecretRead => ({ state: 'unreadable' }))

async function readLegacy(): Promise<LegacyIntegrations> {
  const [linear, voice] = await Promise.all([readSecret(createSecretStore('linear.json')), readSecret(createSecretStore('elevenlabs.json'))])
  const unreadable = { ...(linear.state === 'unreadable' ? { linear: true as const } : {}), ...(voice.state === 'unreadable' ? { voice: true as const } : {}) }
  return {
    linearKey: linear.state === 'value' ? linear.value : null,
    voiceKey: voice.state === 'value' ? voice.value : null,
    voice: readLegacyVoice(),
    ...(Object.keys(unreadable).length > 0 ? { unreadable } : {})
  }
}

/** Connected to the Local server, or null when it does not answer in time (or has no `linear`/`voice`). */
function connectLocal(url: string, token: string): Promise<ServerConnection | null> {
  const conn = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'trek-desktop-handover', clientVersion: app.getVersion() })
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off()
      if (ok) resolve(conn)
      else {
        conn.close()
        resolve(null)
      }
    }
    const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS)
    const off = conn.on('status', ({ status }) => {
      if (status === 'connected') {
        const caps = conn.welcome?.capabilities ?? []
        finish(caps.includes(CAPABILITY.linear) && caps.includes(CAPABILITY.voice))
      } else if (status === 'needs-auth' || status === 'incompatible' || status === 'closed') finish(false)
    })
    conn.connect()
  })
}

/** The Local server's pid this ran for: once per server run (a later start retries what failed). */
let triedPid: number | undefined

/** Runs one after another: a server restart while a hand-over is still going waits for it. */
let chain: Promise<void> = Promise.resolve()
const serial = (task: () => Promise<void>, what: string): void => {
  chain = chain.then(task).catch((err) => console.warn(`trek: could not ${what}`, err))
}

const writeState = (state: HandoverState): Promise<void> => writeFileAtomic(statePath(), JSON.stringify(state, null, 2))

/**
 * Active/Busy stays the app's: voice-settings.json's, into the app settings, once. Needs no
 * server (a remote-only user has one too); left undone when the app settings cannot be written.
 */
async function migrateVoiceActive(): Promise<void> {
  const state = readState("move this app's voice Active/Busy into the app settings")
  if (!state || state.voiceActive) return
  if (readLegacyVoice().active === false && appSettings().voiceActive) await updateAppSettings({ voiceActive: false })
  state.voiceActive = true
  await writeState(state)
}

async function run(): Promise<void> {
  const state = readState('hand the Linear and voice settings to the Local server')
  if (!state) return
  const profile = localProfileKey()
  const done = Object.hasOwn(state.profiles, profile) ? state.profiles[profile] : {}
  if (done.linear && done.voice && !done.voiceConfigPending) return
  const legacy = await readLegacy()
  const unreadable = [legacy.unreadable?.linear && !done.linear ? 'Linear' : '', legacy.unreadable?.voice && !done.voice ? 'ElevenLabs' : ''].filter(Boolean)
  if (unreadable.length > 0) console.warn(`trek: this app's ${unreadable.join(' and ')} key could not be decrypted here; not handed to the Local server (tried again next start)`)
  let next = done
  if (nothingToHandOver(legacy)) next = { linear: true, voice: true }
  else {
    const url = localServerUrl()
    const token = localToken()
    const conn = url && token ? await connectLocal(url, token) : null
    if (conn) {
      try {
        next = await handOver((method, params) => conn.request(method, params as never, { timeoutMs: REQUEST_TIMEOUT_MS }), legacy, done)
      } finally {
        conn.close()
      }
    }
  }
  if (next.linear === done.linear && next.voice === done.voice && next.voiceConfigPending === done.voiceConfigPending) return
  Object.defineProperty(state.profiles, profile, { value: next, enumerable: true, writable: true, configurable: true })
  await writeState(state)
  const parts = [next.linear && !done.linear ? 'Linear' : '', next.voice && !done.voice ? 'ElevenLabs' : ''].filter(Boolean)
  if (parts.length > 0) console.log(`trek: handed this app's ${parts.join(' and ')} settings to the Local server (${profile})`)
}

function maybeRun(): void {
  const status = localServerStatus()
  if (status.state !== 'running' || status.pid === undefined || status.pid === triedPid) return
  triedPid = status.pid
  serial(run, 'hand the Linear and voice settings to the Local server')
}

/**
 * Called once at startup, beside the supervisor: moves the app's Active/Busy into the app settings
 * (whether or not a Local server runs), then hands over each time a new Local server is running.
 */
export function handOverIntegrationsToLocal(): void {
  serial(migrateVoiceActive, "move this app's voice Active/Busy into the app settings")
  onLocalServerChanged(maybeRun)
  maybeRun()
}
