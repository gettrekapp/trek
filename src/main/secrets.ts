import { app, safeStorage } from 'electron'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ownSecret } from './secretsRules'

// When OS-level encryption is unavailable (e.g. Linux without a keyring,
// headless test runs) secrets are stored obfuscated-only, marked with this
// prefix so reads know how to decode them.
const PLAIN_PREFIX = 'plain:'

/** A stored secret as read: none stored, stored but not decryptable here (safeStorage refused, an unreadable file), or its value. */
export type SecretRead = { state: 'absent' } | { state: 'unreadable' } | { state: 'value'; value: string }

export interface SecretStore {
  get: (key: string) => Promise<string | null>
  /** Like `get`, but tells "nothing stored" from "stored and unreadable" (get answers null for both). */
  read: (key: string) => Promise<SecretRead>
  set: (key: string, value: string | null) => Promise<void>
  /**
   * Stores `value` only when `key` has nothing stored, in one step of the write chain: a set
   * queued before it (a token the user just entered) is never overwritten. True when stored.
   */
  setIfAbsent: (key: string, value: string) => Promise<boolean>
}

/**
 * Writes `text` to `path` owner-only (0600) via a temp file and a rename, so a
 * crash mid-write never leaves a truncated file. Callers serialise their writes.
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    throw err
  }
}

/**
 * Secrets encrypted with safeStorage in a userData JSON file — never in the
 * .trekproj (plain JSON that sits next to repos).
 */
export function createSecretStore(fileName: string): SecretStore {
  const filePath = (): string => join(app.getPath('userData'), fileName)

  const readAll = async (): Promise<Record<string, string>> => {
    try {
      const all: unknown = JSON.parse(await readFile(filePath(), 'utf8'))
      return all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, string>) : {}
    } catch {
      return {}
    }
  }

  /** The file as stored, or 'unreadable' when it exists but cannot be read or parsed (absent: {}). */
  const readAllStrict = async (): Promise<Record<string, string> | 'unreadable'> => {
    let text: string
    try {
      text = await readFile(filePath(), 'utf8')
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? {} : 'unreadable'
    }
    try {
      const all: unknown = JSON.parse(text)
      return all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, string>) : 'unreadable'
    } catch {
      return 'unreadable'
    }
  }

  const decode = (stored: string): string | null => {
    if (stored.startsWith(PLAIN_PREFIX)) return Buffer.from(stored.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return null
    }
  }

  /** An own property even for a key like `__proto__`, which a plain assignment would not make. */
  const defineOwn = (all: Record<string, string>, key: string, value: string): void => {
    Object.defineProperty(all, key, { value, enumerable: true, writable: true, configurable: true })
  }

  const encode = (value: string): string =>
    safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : PLAIN_PREFIX + Buffer.from(value, 'utf8').toString('base64')

  /** Every set is a read-modify-write; chained so two never interleave and lose a key. */
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task)
    chain = run.catch(() => undefined)
    return run
  }

  return {
    async get(key) {
      // After any queued set, so a get never sees a value older than a set it followed.
      const stored = ownSecret(await serial(readAll), key)
      return stored ? decode(stored) : null
    },
    async read(key) {
      const all = await serial(readAllStrict)
      if (all === 'unreadable') return { state: 'unreadable' }
      const stored = ownSecret(all, key)
      if (!stored) return { state: 'absent' }
      const value = decode(stored)
      return value ? { state: 'value', value } : { state: 'unreadable' }
    },
    set(key, value) {
      return serial(async () => {
        const all = await readAll()
        if (value === null) {
          delete all[key]
        } else {
          defineOwn(all, key, encode(value))
        }
        await writeFileAtomic(filePath(), JSON.stringify(all, null, 2))
      })
    },
    setIfAbsent(key, value) {
      return serial(async () => {
        const all = await readAll()
        if (ownSecret(all, key) !== null) return false
        defineOwn(all, key, encode(value))
        await writeFileAtomic(filePath(), JSON.stringify(all, null, 2))
        return true
      })
    }
  }
}
