// scripts/latest-linux-yml.mjs — the Linux update feed for one .deb: latest-linux.yml (x64) or
// latest-linux-arm64.yml, beside the file, in electron-updater's format. An installed Trek only
// reads its version (Linux updates are notify-only); the sha512 and size are there all the same.
//
//   node scripts/latest-linux-yml.mjs <Trek-X.Y.Z-linux-<arch>.deb> <X.Y.Z> <x64|arm64>
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function feedName(arch) {
  if (arch === 'x64') return 'latest-linux.yml'
  if (arch === 'arm64') return 'latest-linux-arm64.yml'
  throw new Error(`arch must be x64 or arm64, not ${arch}`)
}

export function linuxFeed({ version, file, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${file}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${file}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n')
}

/** Writes the feed beside `deb`; returns its path. */
export function writeLinuxFeed({ deb, version, arch, releaseDate = new Date().toISOString() }) {
  const sha512 = createHash('sha512').update(readFileSync(deb)).digest('base64')
  const out = join(dirname(deb), feedName(arch))
  writeFileSync(out, linuxFeed({ version, file: basename(deb), sha512, size: statSync(deb).size, releaseDate }))
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [deb, version, arch] = process.argv.slice(2)
  if (!deb || !version || !arch) {
    console.error('usage: node scripts/latest-linux-yml.mjs <deb> <version> <x64|arm64>')
    process.exit(2)
  }
  console.log(writeLinuxFeed({ deb, version, arch }))
}
