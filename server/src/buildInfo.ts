// The server's version and build id. The bundle has both baked in by
// scripts/build.mjs; from source (tsx, tests) the version comes from
// package.json and the build is "dev".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

declare const __TREK_SERVER_VERSION__: string | undefined
declare const __TREK_SERVER_BUILD__: string | undefined

export interface BuildInfo {
  version: string
  build: string
}

export function buildInfo(): BuildInfo {
  return {
    version: typeof __TREK_SERVER_VERSION__ === 'string' ? __TREK_SERVER_VERSION__ : packageVersion(),
    build: typeof __TREK_SERVER_BUILD__ === 'string' ? __TREK_SERVER_BUILD__ : 'dev'
  }
}

/** server/package.json's version, read next to src/ (a source run only). */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
