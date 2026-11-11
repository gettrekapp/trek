// The server's integration keys (phase 5b: Linear, ElevenLabs), in `secrets.json` beside its
// config: owner-only (0600), written then renamed. The keys are write-only over the protocol: a
// client can set, replace or clear one and ask whether it is set, never read it back.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../../src/host/atomicWrite.ts'

export const SECRETS_FILE = 'secrets.json'

/** `secrets.json` in the directory of the server's config file (the Local profile's own, for `--local`). */
export function secretsPathFor(configPath: string): string {
  return join(dirname(configPath), SECRETS_FILE)
}

export interface SecretFile {
  get(name: string): string | null
  /** Stores `value`, or removes the key for null. */
  set(name: string, value: string | null): void
  /** Stores `value` only while nothing is stored under `name`; true when it stored it. */
  setIfAbsent(name: string, value: string): boolean
  /** Every stored key's name */
  keys(): string[]
}

/**
 * Read strictly: a missing file is empty, but one that cannot be read or parse throws, so a write
 * never replaces a file it could not read (and the other key in it) with only its own.
 */
export function createSecretFile(path: string): SecretFile {
  const readAll = (): Record<string, string> => {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error(`${path} cannot be read: ${(err as Error).message}`)
    }
    let all: unknown
    try {
      all = JSON.parse(text)
    } catch (err) {
      throw new Error(`${path} is not valid JSON: ${(err as Error).message}`)
    }
    if (!all || typeof all !== 'object' || Array.isArray(all)) throw new Error(`${path} must hold a JSON object`)
    const out: Record<string, string> = Object.create(null)
    for (const [key, value] of Object.entries(all)) if (typeof value === 'string' && value) out[key] = value
    return out
  }
  const write = (all: Record<string, string>): void => writeFileAtomic(path, JSON.stringify(all, null, 2) + '\n', 0o600)
  return {
    get(name) {
      const all = readAll()
      return Object.hasOwn(all, name) ? all[name] : null
    },
    set(name, value) {
      const all = readAll()
      if (value === null) {
        if (!Object.hasOwn(all, name)) return
        delete all[name]
      } else all[name] = value
      write(all)
    },
    keys() {
      return Object.keys(readAll())
    },
    setIfAbsent(name, value) {
      const all = readAll()
      if (Object.hasOwn(all, name)) return false
      all[name] = value
      write(all)
      return true
    }
  }
}
