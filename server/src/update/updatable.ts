// Whether this trek-server can update itself, and if not, why. Only a release tarball's folder
// can (scripts/package-server.mjs marks it in build.json): its files sit in one folder that can
// be swapped for a newer one. The app's Local server follows the app; a source run has nothing to
// swap; Windows is not supported yet (its files are locked while it runs).
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const UPDATE_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const
export type UpdateTarget = (typeof UPDATE_TARGETS)[number]

/** An install that can update itself */
export interface Install {
  /** The folder holding trek-server.cjs, build.json and bin/ */
  dir: string
  /** The folder that holds it: downloads and the staged version go here */
  parent: string
  version: string
  build: string
  target: UpdateTarget
}

export type InstallCheck = { ok: true; install: Install } | { ok: false; reason: string }

const NOT_A_TARBALL = 'this trek-server was not installed from a release tarball, so it has nothing to replace: update it the way it was installed'

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** `dir`: the folder of the running trek-server.cjs (the bundle's __dirname); '' when there is none (a source run). */
export function readInstall(dir: string, opts: { local?: boolean; platform?: NodeJS.Platform } = {}): InstallCheck {
  const platform = opts.platform ?? process.platform
  if (opts.local) return { ok: false, reason: 'the local server is part of the Trek app and is updated with it' }
  if (platform === 'win32') return { ok: false, reason: 'trek-server does not update itself on Windows yet: unzip the new release beside this one (docs/WINDOWS.md)' }
  if (!dir) return { ok: false, reason: NOT_A_TARBALL }
  let build: Record<string, unknown>
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: NOT_A_TARBALL }
    build = raw as Record<string, unknown>
  } catch {
    return { ok: false, reason: NOT_A_TARBALL }
  }
  if (build.package !== 'tarball' || typeof build.version !== 'string' || typeof build.build !== 'string') return { ok: false, reason: NOT_A_TARBALL }
  const target = build.target
  if (typeof target !== 'string' || !(UPDATE_TARGETS as readonly string[]).includes(target)) {
    return { ok: false, reason: `releases have no self-updating build for ${String(target)}` }
  }
  if (!existsSync(join(dir, 'bin', 'trek-server'))) return { ok: false, reason: `${join(dir, 'bin/trek-server')} is missing: this is not a complete install` }
  const parent = dirname(dir)
  for (const path of [dir, parent]) {
    if (!writable(path)) return { ok: false, reason: `cannot write ${path} as this user, so the install cannot be replaced: update it by hand, or as the user who owns it` }
  }
  return { ok: true, install: { dir, parent, version: build.version, build: build.build, target: target as UpdateTarget } }
}
