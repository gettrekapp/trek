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
import { createSecretStore, writeFileAtomic } from './secrets'
import { handOver, parseHandoverState, type HandoverState, type LegacyIntegrations } from './integrationsHandoverRules'
import { localProfileKey, localServerStatus, localServerUrl, localToken, onLocalServerChanged } from './localServer'

const STATE_FILE = 'integrations-handover.json'
const CONNECT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000

const statePath = (): string => join(app.getPath('userData'), STATE_FILE)

function readState(): HandoverState {
  try {
    return parseHandoverState(JSON.parse(readFileSync(statePath(), 'utf8')))
  } catch {
    return parseHandoverState(undefined)
  }
}

function readLegacyVoice(): LegacyIntegrations['voice'] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(app.getPath('userData'), 'voice-settings.json'), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as LegacyIntegrations['voice']) : {}
  } catch {
    return {}
  }
}

async function readLegacy(): Promise<LegacyIntegrations> {
  const [linearKey, voiceKey] = await Promise.all([
    createSecretStore('linear.json').get('apiKey').catch(() => null),
    createSecretStore('elevenlabs.json').get('apiKey').catch(() => null)
  ])
  return { linearKey, voiceKey, voice: readLegacyVoice() }
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

async function run(): Promise<void> {
  const state = readState()
  const profile = localProfileKey()
  const done = Object.hasOwn(state.profiles, profile) ? state.profiles[profile] : {}
  const legacy = await readLegacy()
  let changed = false
  // Active/Busy stays the app's: voice-settings.json's, into the app settings, once.
  if (!state.voiceActive) {
    if (legacy.voice.active === false && appSettings().voiceActive) await updateAppSettings({ voiceActive: false }).catch(() => undefined)
    state.voiceActive = true
    changed = true
  }
  if (!(done.linear && done.voice) || done.voiceConfigPending) {
    let next = done
    if (!legacy.linearKey && !legacy.voiceKey) next = { linear: true, voice: true }
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
    if (next.linear !== done.linear || next.voice !== done.voice || next.voiceConfigPending !== done.voiceConfigPending) {
      Object.defineProperty(state.profiles, profile, { value: next, enumerable: true, writable: true, configurable: true })
      changed = true
      const parts = [next.linear && !done.linear ? 'Linear' : '', next.voice && !done.voice ? 'ElevenLabs' : ''].filter(Boolean)
      if (parts.length > 0) console.log(`trek: handed this app's ${parts.join(' and ')} settings to the Local server (${profile})`)
    }
  }
  if (changed) await writeFileAtomic(statePath(), JSON.stringify(state, null, 2))
}

function maybeRun(): void {
  const status = localServerStatus()
  if (status.state !== 'running' || status.pid === undefined || status.pid === triedPid) return
  triedPid = status.pid
  void run().catch((err) => console.warn('trek: could not hand the Linear and voice settings to the Local server', err))
}

/** Called once at startup, beside the supervisor: runs each time a new Local server is running. */
export function handOverIntegrationsToLocal(): void {
  onLocalServerChanged(maybeRun)
  maybeRun()
}
