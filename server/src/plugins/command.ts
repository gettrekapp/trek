// `trek-server plugin add | remove | list` (theme plugins phase 1): works on the data dir's
// plugins-installed folder directly, with no connection to a running server, which watches the
// folder and tells its clients. With --local, the data dir of the app's local server.
import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLUGIN_ID_RE } from '../../../src/shared/plugins/manifest.ts'
import { BUILTIN_SERVER_PLUGINS } from '../../../plugins/builtin.server.ts'
import type { CliArgs } from '../cli.ts'
import { defaultDataDir } from '../dataDir.ts'
import { localProfile } from '../localProfile.ts'
import { createInstalledPlugins } from './installed.ts'
import { installedIdReserved } from './reserved.ts'
import { readPluginSource } from './source.ts'

export interface PluginCommandIo {
  log: (line: string) => void
  error: (line: string) => void
  fetch: typeof fetch
}

/** Where the defaults are: a test gives folders of its own. */
export interface PluginCommandPlaces {
  home: string
  /** The platform's data dir (defaultDataDir()) */
  dataDir: string
}

/** The config's `dataDir` when it names one; `problem` when there is a config that cannot be read (none at all is no problem). */
function configuredDataDir(configPath: string): { dataDir?: string; problem?: string } {
  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? {} : { problem: (err as Error).message }
  }
  try {
    const dataDir = (JSON.parse(text) as { dataDir?: unknown } | null)?.dataDir
    return typeof dataDir === 'string' && dataDir ? { dataDir } : {}
  } catch (err) {
    return { problem: (err as Error).message }
  }
}

/** The data dir the server these arguments name would use: `start`'s own order (main.ts). */
function dataDirOf(args: CliArgs, io: PluginCommandIo, places: PluginCommandPlaces): string {
  // The local server's data dir is its profile's, whatever its config says.
  if (args.local) return localProfile(places.home, places.dataDir, args.localProfile).dataDir
  if (args.dataDir !== undefined) return args.dataDir
  const config = configuredDataDir(args.configPath)
  // A server would not start with this config: said, as the plugin then goes where none may look.
  if (config.problem !== undefined) io.error(`Cannot read ${args.configPath}: ${config.problem}; using the default data dir ${resolve(places.dataDir)}`)
  return config.dataDir ?? places.dataDir
}

/** Whether `<dir>/<id>` is a folder of its own (not a link to one). */
function isRealFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The command's exit code. */
export async function runPluginCommand(
  args: CliArgs,
  io: PluginCommandIo = { log: console.log, error: console.error, fetch },
  places: PluginCommandPlaces = { home: homedir(), dataDir: defaultDataDir() }
): Promise<number> {
  const dir = join(resolve(dataDirOf(args, io, places)), 'plugins-installed')
  const store = createInstalledPlugins({ dir, reserved: installedIdReserved(BUILTIN_SERVER_PLUGINS), warn: io.error })
  try {
    if (args.pluginAction === 'list') {
      const plugins = store.list()
      if (plugins.length === 0) io.log(`No plugins installed (${dir}).`)
      for (const { manifest } of plugins) io.log(`${manifest.id}  ${manifest.version}  ${manifest.type ?? 'plugin'}  ${manifest.name}`)
      return 0
    }
    if (args.pluginAction === 'remove') {
      const id = args.pluginTarget!
      if (!store.remove(id)) {
        // A folder the store warns about and does not list (a manifest that broke): removable all the same.
        if (PLUGIN_ID_RE.test(id) && isRealFolder(join(dir, id))) {
          rmSync(join(dir, id), { recursive: true, force: true })
          io.log(`Removed the unlisted folder ${id} from ${dir}.`)
          return 0
        }
        io.error(`No installed plugin with id "${id}". Run \`trek-server plugin list\` to see them.`)
        return 1
      }
      io.log(`Removed ${id} from ${dir}. A running server picks it up automatically.`)
      return 0
    }
    const { manifest } = store.add(await readPluginSource(args.pluginTarget!, io.fetch))
    io.log(`Installed ${manifest.name} (${manifest.id} ${manifest.version}) in ${dir}. A running server picks it up automatically.`)
    return 0
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err))
    return 1
  }
}
