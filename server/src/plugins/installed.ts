// The server's installed plugins (theme plugins phase 1): `<data dir>/plugins-installed/<id>/`
// with manifest.json and client.js. The server stores them and hands them to clients; it never
// runs client.js. Another process may change the folder (`trek-server plugin add`): a running
// server watches it.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch as watchDir, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { MAX_PLUGIN_CLIENT_BYTES, MAX_PLUGIN_MANIFEST_BYTES, PLUGIN_ID_RE, checkPluginPackage, type PluginManifest, type PluginPackage, type PluginPresence } from '../../../src/shared/plugins/manifest.ts'
import { codedError } from '../errors.ts'

export interface InstalledPlugin {
  manifest: PluginManifest
  /** Of client.js's bytes, lowercase hex */
  sha256: string
}

export interface InstalledPluginsOptions {
  /** `<data dir>/plugins-installed` */
  dir: string
  /** Whether an id is a built-in plugin's or a core namespace (reserved.ts) */
  reserved: (id: string) => boolean
  warn?: (message: string) => void
  /** How often a new watch is tried while the folder cannot be watched; a watcher that fails after working this long is replaced at once (default: 30 s) */
  rewatchMs?: number
  /** How long after a watch starts the folder is read once more: a watch is not always live when it returns (default: 2 s) */
  settleMs?: number
  /** How often the folder is read anyway once watch() was called: a missed event is then not for ever (default: 60 s) */
  rescanMs?: number
}

export interface InstalledPlugins {
  /** Sorted by id */
  list(): InstalledPlugin[]
  /** Their entries in the welcome's `plugins` */
  presence(): PluginPresence[]
  /** Installs a package, replacing a plugin of the same id. It is checked here (checkPluginPackage) and stored as cleaned: BAD_REQUEST for one that cannot be installed, or whose id is reserved. */
  add(pkg: PluginPackage): InstalledPlugin
  /** False when no plugin has the id */
  remove(id: string): boolean
  /** client.js as it is now, with its hash. One edited in place since the last scan is a change (the listeners are told); undefined when it can no longer be installed. */
  bundle(id: string): { sha256: string; client: string } | undefined
  /** Reads the folder again; true (and the listeners are told) when it differs from what was known */
  rescan(): boolean
  /** The ids added, replaced or removed, sorted; returns the unsubscribe */
  onChange(listener: (ids: string[]) => void): () => void
  /** Rescans when the folder changes, and now and then anyway. Never throws: a folder that cannot be watched is a warning, and a new watch is tried until one is live. */
  watch(): void
  dispose(): void
}

const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
export const presenceOf = (p: InstalledPlugin): PluginPresence => ({
  id: p.manifest.id,
  version: p.manifest.version,
  defaultEnabled: false,
  type: p.manifest.type,
  name: p.manifest.name,
  description: p.manifest.description,
  contract: p.manifest.contract,
  sha256: p.sha256
})

/** A staging folder (`.tmp-*`, `.old-*`) this old was left by an install that died: one running now is younger. */
const STALE_SCRATCH_MS = 10 * 60_000
/** Linux has a recursive fs.watch from Node 20. */
const RECURSIVE_WATCH = process.platform === 'darwin' || process.platform === 'win32' || Number(process.versions.node.split('.')[0]) >= 20

/** The file's bytes, or why it is not read. Never through a link, nor from a pipe or a folder: lstat, and a regular file only. */
function regularFile(path: string, name: string, maxBytes: number, tooLarge: string): Buffer | string {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile()) return `its ${name} is not a regular file`
    if (stat.size > maxBytes) return tooLarge
    return readFileSync(path)
  } catch (err) {
    return `its ${name} cannot be read: ${(err as Error).message}`
  }
}

/** Whether the bytes are UTF-8 text. A client checks the hash of the text it is sent: other bytes would never match. */
const isUtf8Text = (bytes: Buffer): boolean => Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)

export function createInstalledPlugins(options: InstalledPluginsOptions): InstalledPlugins {
  const { dir } = options
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const listeners = new Set<(ids: string[]) => void>()
  let known = new Map<string, InstalledPlugin>()
  /** The folders the last scan did not list, and why: a rescan warns of what is new. */
  let skipped = new Map<string, string>()
  let watcher: FSWatcher | undefined
  let timer: NodeJS.Timeout | undefined
  /** Runs while the folder has no watcher: after one failed, or when none could be started. */
  let rewatch: NodeJS.Timeout | undefined
  /** The one rescan a moment after a watch started. */
  let settle: NodeJS.Timeout | undefined
  /** The slow rescan, from the first watch() to dispose(). */
  let poll: NodeJS.Timeout | undefined
  let disposed = false
  const rewatchMs = options.rewatchMs ?? 30_000
  /** Why the folder is not watched, as last warned: each try at a new watch does not say it again. */
  let unwatched: string | undefined

  const clientBytes = (id: string): Buffer | string => regularFile(join(dir, id, 'client.js'), 'client.js', MAX_PLUGIN_CLIENT_BYTES, 'its client bundle is larger than 1 MB')

  /** One folder's plugin, or why it is not one. */
  const read = (name: string): InstalledPlugin | string => {
    if (!PLUGIN_ID_RE.test(name)) return 'its folder name is not a plugin id'
    if (options.reserved(name)) return 'its id is a built-in plugin or a core namespace'
    const manifestBytes = regularFile(join(dir, name, 'manifest.json'), 'manifest.json', MAX_PLUGIN_MANIFEST_BYTES, 'its manifest is larger than 16 KB')
    if (typeof manifestBytes === 'string') return manifestBytes
    let manifest: unknown
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'))
    } catch (err) {
      return `its manifest.json cannot be read: ${(err as Error).message}`
    }
    const bytes = clientBytes(name)
    if (typeof bytes === 'string') return bytes
    if (!isUtf8Text(bytes)) return 'its client.js is not UTF-8 text'
    const checked = checkPluginPackage({ manifest, client: bytes.toString('utf8') })
    if (checked.problem !== undefined) return checked.problem
    if (checked.package.manifest.id !== name) return `its manifest's id (${checked.package.manifest.id}) is not its folder's name`
    return { manifest: checked.package.manifest, sha256: sha256Of(bytes) }
  }

  const scan = (): Map<string, InstalledPlugin> => {
    const found = new Map<string, InstalledPlugin>()
    const reasons = new Map<string, string>()
    try {
      // A link to a folder is named too, to be refused aloud: the entry is the link's own (not followed).
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
        .sort((a, b) => (a.name < b.name ? -1 : 1))
      for (const entry of entries) {
        const plugin = entry.isSymbolicLink() ? 'it is a symbolic link, and a plugin is a folder of its own' : read(entry.name)
        if (typeof plugin === 'string') reasons.set(entry.name, plugin)
        else found.set(entry.name, plugin)
      }
    } catch {
      // No folder yet: no plugins.
    }
    for (const [name, reason] of reasons) if (skipped.get(name) !== reason) warn(`[plugins] installed plugin ${name} not listed: ${reason}`)
    skipped = reasons
    return found
  }

  const same = (a: InstalledPlugin | undefined, b: InstalledPlugin | undefined): boolean =>
    a === b || (!!a && !!b && JSON.stringify(presenceOf(a)) === JSON.stringify(presenceOf(b)))

  /** Takes `next` as what is known; tells the listeners the ids whose entry differs (a name or a description too). */
  const adopt = (next: Map<string, InstalledPlugin>): boolean => {
    const ids = [...new Set([...known.keys(), ...next.keys()])].filter((id) => !same(known.get(id), next.get(id))).sort()
    known = next
    if (ids.length === 0) return false
    for (const listener of [...listeners]) {
      // One that throws fails neither the install that was just made nor the listeners after it, and the watch's timer has nobody to throw to.
      try {
        listener(ids)
      } catch (err) {
        warn(`[plugins] a listener of installed plugin changes failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return true
  }

  const scratch = (prefix: string, id: string): string => join(dir, `.${prefix}-${id}-${randomBytes(6).toString('hex')}`)

  /** Removes what an install that died left behind. Best effort. */
  const sweep = (): void => {
    let names: string[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\.(tmp|old)-/.test(entry.name))
        .map((entry) => entry.name)
    } catch {
      return
    }
    for (const name of names) {
      try {
        // Another process may be installing right now (`trek-server plugin add`): its folders are new.
        if (Date.now() - lstatSync(join(dir, name)).mtimeMs < STALE_SCRATCH_MS) continue
        rmSync(join(dir, name), { recursive: true, force: true })
      } catch (err) {
        warn(`[plugins] could not remove the leftover folder ${join(dir, name)}: ${(err as Error).message}`)
      }
    }
  }

  const cannotWatch = (err: unknown): void => {
    const reason = err instanceof Error ? err.message : String(err)
    if (reason !== unwatched) warn(`[plugins] cannot watch ${dir}: ${reason}`)
    unwatched = reason
  }

  /** Starts a watcher; false (and a warning) when the folder cannot be watched now. */
  const open = (): boolean => {
    // One rescan for a burst of events (an add is several renames and writes).
    const changed = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => adopt(scan()), 200)
    }
    // Recursive, to hear a client.js edited inside its folder; plain where that cannot be had
    // (bundle() and the slow rescan still notice such an edit).
    const watchIt = (recursive: boolean): FSWatcher => watchDir(dir, { recursive }, changed)
    let opened: FSWatcher
    // Out of watches or of files, a folder that cannot be made: the server still starts, lists
    // its plugins and takes its own installs. What the command changes is read by the slow rescan.
    try {
      mkdirSync(dir, { recursive: true })
      try {
        opened = watchIt(RECURSIVE_WATCH)
      } catch (err) {
        if (!RECURSIVE_WATCH) throw err
        opened = watchIt(false)
      }
    } catch (err) {
      cannotWatch(err)
      return false
    }
    watcher = opened
    const openedAt = Date.now()
    opened.on('error', (err) => {
      cannotWatch(err)
      opened.close()
      if (watcher !== opened || disposed) return
      watcher = undefined
      // At once: a folder removed and made again can be watched straight away. Not for a watcher
      // that failed as soon as it started: one after another would fail with no pause between them.
      if (Date.now() - openedAt >= rewatchMs) startWatch()
      else retryLater()
    })
    return true
  }

  /** Nobody else calls watch() again: it is tried from here until one is live. */
  const retryLater = (): void => {
    rewatch ??= setInterval(startWatch, rewatchMs).unref()
  }

  const startWatch = (): void => {
    if (watcher || disposed) return
    // Whatever the watch does or misses, the folder is read now and then.
    poll ??= setInterval(() => adopt(scan()), options.rescanMs ?? 60_000).unref()
    if (!open()) return retryLater()
    clearInterval(rewatch)
    rewatch = undefined
    // What changed while nothing watched.
    if (unwatched !== undefined) adopt(scan())
    unwatched = undefined
    // The watch may become live only after it returns (macOS): what changed before that is read once it surely is.
    clearTimeout(settle)
    settle = setTimeout(() => adopt(scan()), options.settleMs ?? 2_000).unref()
  }

  sweep()
  known = scan()

  return {
    list: () => [...known.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)),
    presence() {
      return this.list().map(presenceOf)
    },
    add(given) {
      // Whoever calls: nothing unchecked is stored.
      const checked = checkPluginPackage(given)
      if (checked.problem !== undefined) throw codedError('BAD_REQUEST', `Not an installable plugin: ${checked.problem}`)
      const pkg = checked.package
      const id = pkg.manifest.id
      if (options.reserved(id)) throw codedError('BAD_REQUEST', `${id} is the id of a built-in plugin or a core namespace`)
      mkdirSync(dir, { recursive: true })
      const staged = scratch('tmp', id)
      mkdirSync(staged)
      let old: string | undefined
      try {
        // Compact, as checkPluginPackage measured it: what was accepted is never too large for the scan.
        writeFileSync(join(staged, 'manifest.json'), `${JSON.stringify(pkg.manifest)}\n`)
        writeFileSync(join(staged, 'client.js'), pkg.client)
        const target = join(dir, id)
        if (existsSync(target)) {
          // A folder cannot be renamed onto one that has files: the old one steps aside first.
          const aside = scratch('old', id)
          renameSync(target, aside)
          old = aside
        }
        try {
          renameSync(staged, target)
        } catch (err) {
          // A failed upgrade is not an uninstall: the old one goes back.
          if (old) {
            try {
              renameSync(old, target)
            } catch (back) {
              warn(`[plugins] ${id} could not be put back after its replacement failed; it was left in ${old}: ${(back as Error).message}`)
            }
          }
          throw err
        }
      } catch (err) {
        rmSync(staged, { recursive: true, force: true })
        throw err
      }
      // The new one is in place whatever becomes of the old: a folder that stays is swept at a later start.
      if (old) {
        try {
          rmSync(old, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch (err) {
          warn(`[plugins] could not remove ${old}, the replaced ${id}: ${(err as Error).message}`)
        }
      }
      const plugin: InstalledPlugin = { manifest: pkg.manifest, sha256: sha256Of(Buffer.from(pkg.client, 'utf8')) }
      adopt(new Map(known).set(id, plugin))
      return plugin
    },
    remove(id) {
      if (!known.has(id)) return false
      rmSync(join(dir, id), { recursive: true, force: true })
      const next = new Map(known)
      next.delete(id)
      adopt(next)
      return true
    },
    bundle(id) {
      if (!known.has(id)) return undefined
      // The file as it is now, under its own hash: a client never accepts text under a stale one.
      const bytes = clientBytes(id)
      const sha256 = typeof bytes === 'string' ? '' : sha256Of(bytes)
      // Edited in place since the scan (a watch that is not recursive never says so): the scan decides
      // whether it is still a plugin, and the listeners hear of the new hash.
      if (sha256 !== known.get(id)!.sha256) adopt(scan())
      // The scan checked the bytes that have this hash. Changed again meanwhile: the asker asks again.
      if (typeof bytes === 'string' || known.get(id)?.sha256 !== sha256) return undefined
      return { sha256, client: bytes.toString('utf8') }
    },
    rescan: () => adopt(scan()),
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    watch: startWatch,
    dispose() {
      disposed = true
      clearTimeout(timer)
      clearTimeout(settle)
      clearInterval(rewatch)
      clearInterval(poll)
      rewatch = undefined
      poll = undefined
      watcher?.close()
      watcher = undefined
      listeners.clear()
    }
  }
}
