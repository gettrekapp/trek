import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** This machine agreed that this project may run this command from this folder. */
export interface ConsentEntry {
  projectFile: string
  folder: string
  command: string
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function consentEntry(projectFile: string, folder: string, command: string): ConsentEntry {
  return { projectFile: realOrResolved(projectFile), folder: realOrResolved(folder), command: command.trim() }
}

const same = (a: ConsentEntry, b: ConsentEntry): boolean =>
  a.projectFile === b.projectFile && a.folder === b.folder && a.command === b.command

export const hasConsent = (entries: ConsentEntry[], entry: ConsentEntry): boolean =>
  entries.some((e) => same(e, entry))

export const addConsent = (entries: ConsentEntry[], entry: ConsentEntry): ConsentEntry[] =>
  hasConsent(entries, entry) ? entries : [...entries, entry]

function isEntry(value: unknown): value is ConsentEntry {
  const e = value as ConsentEntry | null
  return typeof e?.projectFile === 'string' && typeof e.folder === 'string' && typeof e.command === 'string'
}

/** Anything unreadable means no consent, which only asks again. */
export function parseConsent(raw: string): ConsentEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isEntry) : []
  } catch {
    return []
  }
}

/**
 * Why the bot can't run this command, or null. A turn's working directory is the bot's folder, so a
 * relative path would run whatever a shared folder happens to contain.
 */
export function commandProblem(command: string): string | null {
  const bin = command.trim().split(/\s+/)[0]
  if (!bin) return "The bot's command is empty."
  if (isAbsolute(bin) || !/[\\/]/.test(bin)) return null
  return `The bot's command must be an absolute path or a bare command name on PATH, not a relative path: ${bin}`
}
