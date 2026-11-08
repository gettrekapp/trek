// The secret store's lookups (secrets.ts), pure. A key is a server id that can come from a
// file (a legacy .trekproj's `servers`), so `constructor` or `__proto__` must find nothing.

/** The stored value under `key`: an own string property of what the file held, or null. */
export function ownSecret(all: unknown, key: string): string | null {
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null
  if (!Object.hasOwn(all, key)) return null
  const value = (all as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : null
}
