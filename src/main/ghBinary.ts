// The gh executable main runs (phase 5c-1 review), as the server picks its own (server/src/prWatch/gh.ts):
// `gh` on the PATH when TREK_SERVER_GH is unset, the variable itself when it is an absolute path (every
// smoke points it at a stub, so no smoke reaches the real gh through main), and null for any other
// value: treated as no gh, so a typo never falls back to the real one.
import { isAbsolute } from 'node:path'

export function ghBinary(value: string | undefined): string | null {
  if (value === undefined) return 'gh'
  return isAbsolute(value) ? value : null
}

/**
 * Whether a gh that failed may be backed up by GitHub's public API: only while TREK_SERVER_GH is
 * unset (final review). Set to anything, gh is stubbed or turned off, and nothing reaches GitHub.
 */
export function publicApiFallback(value: string | undefined): boolean {
  return value === undefined
}
