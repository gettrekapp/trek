// An update's memory. In the install folder, the markers that carry it across a restart:
// update-pending.json (this version has not started yet), update-pending.tried (the launcher
// attempted one start) and update-rolled-back.json (the launcher put the version before it back).
// In the config folder, update-state.json: when the feed was last read, what it offered, and how
// the last update went, for `trek-server update --check` and (phase 3) the clients.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../../src/host/atomicWrite.ts'

export const PENDING_FILE = 'update-pending.json'
export const TRIED_FILE = 'update-pending.tried'
export const ROLLED_BACK_FILE = 'update-rolled-back.json'
export const STATE_FILE = 'update-state.json'

/** The versions an update goes between, and when it was installed (ISO) */
export interface PendingUpdate {
  from: string
  to: string
  at: string
}

export interface UpdateResult {
  ok: boolean
  from: string
  to: string
  /** When it was settled (ISO) */
  at: string
  error?: string
}

export interface UpdateState {
  lastCheckAt?: string
  /** A newer version the last check found */
  latest?: string
  lastResult?: UpdateResult
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function pendingOf(path: string): PendingUpdate | null {
  const raw = readJson(path)
  if (!raw || typeof raw.from !== 'string' || typeof raw.to !== 'string' || typeof raw.at !== 'string') return null
  return { from: raw.from, to: raw.to, at: raw.at }
}

/** A missing or unreadable file is empty. */
export function readState(configDir: string): UpdateState {
  return (readJson(join(configDir, STATE_FILE)) ?? {}) as UpdateState
}

/** Merges `patch` into update-state.json; a key set to undefined is removed. */
export function writeState(configDir: string, patch: Partial<UpdateState>): void {
  const next: Record<string, unknown> = { ...readState(configDir) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  writeFileAtomic(join(configDir, STATE_FILE), JSON.stringify(next, null, 2) + '\n', 0o600)
}

/** Marks the folder `dir` (the staged new version, before the swap) as not started yet. */
export function writePending(dir: string, pending: PendingUpdate): void {
  writeFileSync(join(dir, PENDING_FILE), JSON.stringify(pending) + '\n')
}

/**
 * Once the server is listening: settles what the markers say and records it. A rolled-back marker
 * (this is the version the launcher restored) is a failed update; a pending one (this is the new
 * version, and it started) is a successful one. Returns the result, or null when there was
 * nothing to settle. Never throws: a marker that cannot be read or removed must not stop a server.
 */
export function settleStart(installDir: string, configDir: string, now: Date = new Date()): UpdateResult | null {
  const at = now.toISOString()
  let result: UpdateResult | null = null
  try {
    const rolledBackPath = join(installDir, ROLLED_BACK_FILE)
    const pendingPath = join(installDir, PENDING_FILE)
    if (existsSync(rolledBackPath)) {
      const rolledBack = pendingOf(rolledBackPath)
      rmSync(rolledBackPath, { force: true })
      // The restored version has no update pending: a marker left here is not a start to report.
      rmSync(pendingPath, { force: true })
      if (rolledBack) {
        result = {
          ok: false,
          from: rolledBack.from,
          to: rolledBack.to,
          at,
          error: `trek-server ${rolledBack.to} did not start; went back to ${rolledBack.from}`
        }
      }
    } else if (existsSync(pendingPath)) {
      const pending = pendingOf(pendingPath)
      rmSync(pendingPath, { force: true })
      if (pending) result = { ok: true, from: pending.from, to: pending.to, at }
    }
    rmSync(join(installDir, TRIED_FILE), { force: true })
    if (result) writeState(configDir, { lastResult: result })
  } catch (err) {
    console.warn(`update: could not settle the last update's markers: ${(err as Error).message}`)
  }
  return result
}
