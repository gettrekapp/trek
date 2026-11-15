// `trek-server plugin add | remove | list` (theme plugins phase 1): works on the data dir's
// plugins-installed folder directly, with no connection to a running server, which watches the
// folder and tells its clients.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BUILTIN_SERVER_PLUGINS } from '../../../plugins/builtin.server.ts'
import type { CliArgs } from '../cli.ts'
import { defaultDataDir } from '../dataDir.ts'
import { createInstalledPlugins } from './installed.ts'
import { installedIdReserved } from './reserved.ts'
import { readPluginSource } from './source.ts'

export interface PluginCommandIo {
  log: (line: string) => void
  error: (line: string) => void
  fetch: typeof fetch
}

/** The config's `dataDir`, when the config can be read and names one. */
function configuredDataDir(configPath: string): string | undefined {
  try {
    const dataDir = (JSON.parse(readFileSync(configPath, 'utf8')) as { dataDir?: unknown }).dataDir
    return typeof dataDir === 'string' && dataDir ? dataDir : undefined
  } catch {
    return undefined
  }
}

/** The command's exit code. */
export async function runPluginCommand(args: CliArgs, io: PluginCommandIo = { log: console.log, error: console.error, fetch }): Promise<number> {
  const dataDir = resolve(args.dataDir ?? configuredDataDir(args.configPath) ?? defaultDataDir())
  const dir = join(dataDir, 'plugins-installed')
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
