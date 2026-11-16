// The secret store's lookups (secrets.ts), pure. A key is a server id that can come from a
// file (a legacy .trekproj's `servers`), so `constructor` or `__proto__` must find nothing.

/** The stored value under `key`: an own string property of what the file held, or null. */
export function ownSecret(all: unknown, key: string): string | null {
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null
  if (!Object.hasOwn(all, key)) return null
  const value = (all as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : null
}

/** How the secret store keeps what it saves on this machine. */
export type SecretStorageKind = 'encrypted' | 'unencrypted'

/**
 * `available`: safeStorage.isEncryptionAvailable(). `backend`: on Linux,
 * safeStorage.getSelectedStorageBackend() after ready; ignored elsewhere. Linux without GNOME
 * Keyring or KWallet uses `basic_text`, a key fixed in Chromium: encrypted in name only.
 */
export function secretStorageKind(o: { platform: string; available: boolean; backend: string | undefined }): SecretStorageKind {
  if (!o.available) return 'unencrypted'
  if (o.platform !== 'linux') return 'encrypted'
  return o.backend === 'gnome_libsecret' || (o.backend ?? '').startsWith('kwallet') ? 'encrypted' : 'unencrypted'
}
