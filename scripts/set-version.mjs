// scripts/set-version.mjs — one product version for the app, trek-server and trek-relay.
//
// A release tag `vX.Y.Z` is the product version: the app (package.json), the server
// (server/package.json, baked into trek-server.cjs and build.json) and the relay
// (relay/package.json, baked into trek-relay.cjs) all carry it. The phone app (apps/mobile)
// keeps its own version: EAS builds it, not the release workflow.
//
//   node scripts/set-version.mjs 0.3.0        writes 0.3.0 into the three package.json files and
//                                              their package-lock.json root entries; refuses a
//                                              version below any of theirs unless --allow-lower
//   node scripts/set-version.mjs --check v0.3.0
//                                              exits 1, naming each file, unless all three are
//                                              0.3.0; prints the version (the release workflow's
//                                              tag check)
//
// The Local server supervisor compares the running server's version with the bundled one
// (src/main/localServerRules.ts compareVersions), so a new version must not be lower than the
// last one shipped in any of the three.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
export const PACKAGES = ['', 'server/', 'relay/']
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** `v1.2.3` or `1.2.3` → `1.2.3`; undefined when it is not a semver version. */
export function versionFromTag(tag) {
  const v = String(tag ?? '').replace(/^refs\/tags\//, '').replace(/^v/, '')
  return SEMVER.test(v) ? v : undefined
}

/** [file, version] for each package.json. */
export function currentVersions(base = root) {
  return PACKAGES.map((dir) => [`${dir}package.json`, JSON.parse(readFileSync(`${base}${dir}package.json`, 'utf8')).version])
}

/** Splits `X.Y.Z-pre.release` at its first '-': the prerelease is everything after it (undefined if none). */
function splitVersion(v) {
  const dash = v.indexOf('-')
  return dash < 0 ? [v, undefined] : [v.slice(0, dash), v.slice(dash + 1)]
}

/** Two prerelease identifiers, per semver: numeric ones numerically and below alphanumeric ones, which compare as ASCII. */
function compareIdentifiers(a, b) {
  const numA = /^\d+$/.test(a)
  const numB = /^\d+$/.test(b)
  if (numA && numB) return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0
  if (numA) return -1
  if (numB) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * <0, 0 or >0 as a is below, equal to or above b, by semver precedence: X.Y.Z numerically, a
 * prerelease below its release, and prereleases identifier by identifier (rc.2 < rc.10 < rc.10.1).
 */
export function compareVersions(a, b) {
  const [ma, pa] = splitVersion(a)
  const [mb, pb] = splitVersion(b)
  const na = ma.split('.').map(Number)
  const nb = mb.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (na[i] !== nb[i]) return na[i] - nb[i]
  if (pa === pb) return 0
  if (pa === undefined) return 1
  if (pb === undefined) return -1
  const ia = pa.split('.')
  const ib = pb.split('.')
  for (let i = 0; i < Math.min(ia.length, ib.length); i++) {
    const c = compareIdentifiers(ia[i], ib[i])
    if (c !== 0) return c
  }
  return ia.length - ib.length
}

/** The files whose version is not `version`, as "file: found". */
export function mismatches(version, base = root) {
  return currentVersions(base).filter(([, v]) => v !== version).map(([file, v]) => `${file}: ${v}`)
}

function rewrite(path, edit) {
  const text = readFileSync(path, 'utf8')
  const json = JSON.parse(text)
  edit(json)
  writeFileSync(path, JSON.stringify(json, null, 2) + (text.endsWith('\n') ? '\n' : ''))
}

export function setVersion(version, base = root) {
  for (const dir of PACKAGES) {
    rewrite(`${base}${dir}package.json`, (pkg) => { pkg.version = version })
    rewrite(`${base}${dir}package-lock.json`, (lock) => {
      lock.version = version
      if (lock.packages?.['']) lock.packages[''].version = version
    })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const allowLower = process.argv.includes('--allow-lower')
  const args = process.argv.slice(2).filter((a) => a !== '--allow-lower')
  const check = args[0] === '--check'
  const arg = check ? args[1] : args[0]
  const version = versionFromTag(arg)
  if (!version) {
    console.error(`set-version: "${arg ?? ''}" is not a version (X.Y.Z or vX.Y.Z, optionally -prerelease)`)
    console.error('usage: node scripts/set-version.mjs <X.Y.Z> | --check <vX.Y.Z>')
    process.exit(2)
  }
  if (check) {
    const bad = mismatches(version)
    if (bad.length) {
      console.error(`set-version: the tag says ${version}, but ${bad.join(', ')}.`)
      console.error(`Run \`node scripts/set-version.mjs ${version}\`, commit, and tag that commit.`)
      process.exit(1)
    }
    console.log(version)
  } else {
    const higher = currentVersions().filter(([, v]) => compareVersions(version, v) < 0)
    if (higher.length && !allowLower) {
      console.error(`set-version: ${version} is below ${higher.map(([f, v]) => `${f} (${v})`).join(', ')}; the Local server`)
      console.error('supervisor treats a lower bundled version as older. Pass --allow-lower to write it anyway.')
      process.exit(1)
    }
    setVersion(version)
    for (const [file, v] of currentVersions()) console.log(`${file}: ${v}`)
  }
}
