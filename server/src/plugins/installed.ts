// The server's installed plugins (theme plugins phase 1): `<data dir>/plugins-installed/<id>/`
// with manifest.json and client.js. The server stores them and hands them to clients; it never
// runs client.js. Another process may change the folder (`trek-server plugin add`): a running
// server watches it.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch as watchDir, writeFileSync, type FSWatcher } from 'node:fs'
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
}

export interface InstalledPlugins {
  /** Sorted by id */
  list(): InstalledPlugin[]
  /** Their entries in the welcome's `plugins` */
  presence(): PluginPresence[]
  /** Installs a checked package (checkPluginPackage), replacing a plugin of the same id. BAD_REQUEST for a reserved id. */
  add(pkg: PluginPackage): InstalledPlugin
  /** False when no plugin has the id */
  remove(id: string): boolean
  bundle(id: string): { sha256: string; client: string } | undefined
  /** Reads the folder again; true (and the listeners are told) when it differs from what was known */
  rescan(): boolean
  /** The ids added, replaced or removed, sorted; returns the unsubscribe */
  onChange(listener: (ids: string[]) => void): () => void
  /** Rescans when the folder changes */
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

export function createInstalledPlugins(options: InstalledPluginsOptions): InstalledPlugins {
  const { dir } = options
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const listeners = new Set<(ids: string[]) => void>()
  let known = new Map<string, InstalledPlugin>()
  let watcher: FSWatcher | undefined
  let timer: NodeJS.Timeout | undefined

  /** One folder's plugin, or why it is not one. */
  const read = (name: string): InstalledPlugin | string => {
    if (!PLUGIN_ID_RE.test(name)) return 'its folder name is not a plugin id'
    if (options.reserved(name)) return 'its id is a built-in plugin or a core namespace'
    const manifestPath = join(dir, name, 'manifest.json')
    const clientPath = join(dir, name, 'client.js')
    let manifest: unknown
    let bytes: Buffer
    try {
      if (statSync(manifestPath).size > MAX_PLUGIN_MANIFEST_BYTES) return 'its manifest is larger than 16 KB'
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      return `its manifest.json cannot be read: ${(err as Error).message}`
    }
    try {
      if (statSync(clientPath).size > MAX_PLUGIN_CLIENT_BYTES) return 'its client bundle is larger than 1 MB'
      bytes = readFileSync(clientPath)
    } catch (err) {
      return `its client.js cannot be read: ${(err as Error).message}`
    }
    const client = bytes.toString('utf8')
    // A client checks the hash of the text it is sent: bytes that are not UTF-8 would never match.
    if (!Buffer.from(client, 'utf8').equals(bytes)) return 'its client.js is not UTF-8 text'
    const checked = checkPluginPackage({ manifest, client })
    if (checked.problem !== undefined) return checked.problem
    if (checked.package.manifest.id !== name) return `its manifest's id (${checked.package.manifest.id}) is not its folder's name`
    return { manifest: checked.package.manifest, sha256: sha256Of(bytes) }
  }

  const scan = (): Map<string, InstalledPlugin> => {
    const found = new Map<string, InstalledPlugin>()
    let names: string[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort()
    } catch {
      return found
    }
    for (const name of names) {
      const plugin = read(name)
      if (typeof plugin === 'string') warn(`[plugins] installed plugin ${name} not listed: ${plugin}`)
      else found.set(name, plugin)
    }
    return found
  }

  /** Takes `next` as what is known; tells the listeners the ids that differ. */
  const adopt = (next: Map<string, InstalledPlugin>): boolean => {
    const ids = [...new Set([...known.keys(), ...next.keys()])].filter((id) => known.get(id)?.sha256 !== next.get(id)?.sha256 || known.get(id)?.manifest.version !== next.get(id)?.manifest.version).sort()
    known = next
    if (ids.length === 0) return false
    for (const listener of [...listeners]) listener(ids)
    return true
  }

  const scratch = (prefix: string, id: string): string => join(dir, `.${prefix}-${id}-${randomBytes(6).toString('hex')}`)

  known = scan()

  return {
    list: () => [...known.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)),
    presence() {
      return this.list().map(presenceOf)
    },
    add(pkg) {
      const id = pkg.manifest.id
      if (!PLUGIN_ID_RE.test(id)) throw codedError('BAD_REQUEST', `${JSON.stringify(id)} is not a plugin id`)
      if (options.reserved(id)) throw codedError('BAD_REQUEST', `${id} is the id of a built-in plugin or a core namespace`)
      mkdirSync(dir, { recursive: true })
      const staged = scratch('tmp', id)
      mkdirSync(staged)
      try {
        writeFileSync(join(staged, 'manifest.json'), `${JSON.stringify(pkg.manifest, null, 2)}\n`)
        writeFileSync(join(staged, 'client.js'), pkg.client)
        const target = join(dir, id)
        if (existsSync(target)) {
          // A folder cannot be renamed onto one that has files: the old one steps aside first.
          const old = scratch('old', id)
          renameSync(target, old)
          renameSync(staged, target)
          rmSync(old, { recursive: true, force: true })
        } else renameSync(staged, target)
      } catch (err) {
        rmSync(staged, { recursive: true, force: true })
        throw err
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
      const plugin = known.get(id)
      if (!plugin) return undefined
      let bytes: Buffer
      try {
        bytes = readFileSync(join(dir, id, 'client.js'))
      } catch {
        return undefined
      }
      // The file as it is now: its own hash, so a client never accepts text under a stale one.
      return { sha256: sha256Of(bytes), client: bytes.toString('utf8') }
    },
    rescan: () => adopt(scan()),
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    watch() {
      if (watcher) return
      mkdirSync(dir, { recursive: true })
      // One rescan for a burst of events (an add is several renames and writes).
      watcher = watchDir(dir, () => {
        clearTimeout(timer)
        timer = setTimeout(() => adopt(scan()), 200)
      })
      watcher.on('error', (err) => warn(`[plugins] cannot watch ${dir}: ${err.message}`))
    },
    dispose() {
      clearTimeout(timer)
      watcher?.close()
      watcher = undefined
      listeners.clear()
    }
  }
}
