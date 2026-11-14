// scripts/latest-mac-yml.mjs — the release's latest-mac.yml (electron-builder writes it; the app's
// updater reads it from the GitHub release).
//
//   node scripts/latest-mac-yml.mjs dist/latest-mac.yml
//
// 1. Drops the dmg's entry: the release workflow staples the dmg after electron-builder wrote the
//    file, so the dmg's sha512 there is stale. The macOS updater installs only the zip.
// 2. Checks every file still listed (the zip) against the file beside the yml: size and sha512.
//
// The file is rewritten in place. It is electron-builder's own YAML, edited line by line (no YAML
// parser): a `files:` list of `  - url:` items with indented fields, then top-level fields.
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ITEM = /^  - url: (.+)$/
const FIELD = /^    ([A-Za-z0-9]+): (.+)$/

/** A YAML scalar as electron-builder writes it: bare, or in single or double quotes. */
function scalar(raw) {
  const value = raw.trim()
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) return value.slice(1, -1)
  return value
}

/** The `files:` list as [{ url, sha512, size }]. */
export function listFiles(text) {
  const files = []
  let inFiles = false
  for (const line of text.split('\n')) {
    if (line === 'files:') {
      inFiles = true
      continue
    }
    if (!inFiles) continue
    const item = ITEM.exec(line)
    if (item) {
      files.push({ url: scalar(item[1]) })
      continue
    }
    const field = FIELD.exec(line)
    if (field && files.length > 0) {
      const current = files[files.length - 1]
      if (field[1] === 'sha512') current.sha512 = scalar(field[2])
      else if (field[1] === 'size') current.size = Number(scalar(field[2]))
      continue
    }
    // The first line that is neither an item nor an item's field ends the list.
    inFiles = false
  }
  return files
}

/** The text without the `files:` items whose url ends in .dmg. Throws when what is left is not a zip the updater can use. */
export function dropDmg(text) {
  if (!text.split('\n').includes('files:')) throw new Error('latest-mac.yml has no files: list')
  const out = []
  let inFiles = false
  let dropping = false
  for (const line of text.split('\n')) {
    if (line === 'files:') {
      inFiles = true
      out.push(line)
      continue
    }
    if (inFiles) {
      const item = ITEM.exec(line)
      if (item) {
        dropping = scalar(item[1]).toLowerCase().endsWith('.dmg')
        if (!dropping) out.push(line)
        continue
      }
      if (FIELD.test(line)) {
        if (!dropping) out.push(line)
        continue
      }
      inFiles = false
      dropping = false
    }
    out.push(line)
  }
  const result = out.join('\n')
  const files = listFiles(result)
  if (!files.some((f) => f.url.toLowerCase().endsWith('.zip'))) throw new Error('latest-mac.yml lists no .zip: the updater has nothing to install')
  const path = /^path: (.+)$/m.exec(result)
  if (!path || !scalar(path[1]).toLowerCase().endsWith('.zip')) {
    throw new Error(`latest-mac.yml's path is ${path ? scalar(path[1]) : 'missing'}, not the .zip`)
  }
  return result
}

/** Every listed file, beside the yml in `dir`: its size and sha512 (base64) are what the yml says. */
export function verifyFiles(text, dir) {
  for (const file of listFiles(text)) {
    if (file.url !== basename(file.url) || file.url.includes('..')) throw new Error(`latest-mac.yml: ${file.url} is not a plain file name`)
    const path = join(dir, file.url)
    let size
    try {
      size = statSync(path).size
    } catch {
      throw new Error(`latest-mac.yml names ${file.url}, which is not in ${dir}`)
    }
    if (size !== file.size) throw new Error(`${file.url}: size is ${size}, latest-mac.yml says ${file.size}`)
    const sha512 = createHash('sha512').update(readFileSync(path)).digest('base64')
    if (sha512 !== file.sha512) throw new Error(`${file.url}: sha512 is ${sha512}, latest-mac.yml says ${file.sha512}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node scripts/latest-mac-yml.mjs <path to latest-mac.yml>')
    process.exit(2)
  }
  try {
    const next = dropDmg(readFileSync(target, 'utf8'))
    verifyFiles(next, dirname(target))
    writeFileSync(target, next)
    console.log(`${target}:\n${next}`)
  } catch (err) {
    console.error(`latest-mac-yml: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
