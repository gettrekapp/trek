import { app, safeStorage } from 'electron'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// When OS-level encryption is unavailable (e.g. Linux without a keyring,
// headless test runs) secrets are stored obfuscated-only, marked with this
// prefix so reads know how to decode them.
const PLAIN_PREFIX = 'plain:'

export interface SecretStore {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string | null) => Promise<void>
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
      return JSON.parse(await readFile(filePath(), 'utf8'))
    } catch {
      return {}
    }
  }

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
      const stored = (await serial(readAll))[key]
      if (!stored) return null
      if (stored.startsWith(PLAIN_PREFIX)) {
        return Buffer.from(stored.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
      }
      try {
        return safeStorage.decryptString(Buffer.from(stored, 'base64'))
      } catch {
        return null
      }
    },
    set(key, value) {
      return serial(async () => {
        const all = await readAll()
        if (value === null) {
          delete all[key]
        } else if (safeStorage.isEncryptionAvailable()) {
          all[key] = safeStorage.encryptString(value).toString('base64')
        } else {
          all[key] = PLAIN_PREFIX + Buffer.from(value, 'utf8').toString('base64')
        }
        await writeFileAtomic(filePath(), JSON.stringify(all, null, 2))
      })
    }
  }
}
