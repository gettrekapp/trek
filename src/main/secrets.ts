import { app, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
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

  return {
    async get(key) {
      const stored = (await readAll())[key]
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
    async set(key, value) {
      const all = await readAll()
      if (value === null) {
        delete all[key]
      } else if (safeStorage.isEncryptionAvailable()) {
        all[key] = safeStorage.encryptString(value).toString('base64')
      } else {
        all[key] = PLAIN_PREFIX + Buffer.from(value, 'utf8').toString('base64')
      }
      await writeFile(filePath(), JSON.stringify(all, null, 2), 'utf8')
    }
  }
}
