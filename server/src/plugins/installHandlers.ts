// The plugins.* protocol methods of installed plugins (theme plugins phase 1): a client reads a
// plugin's bundle, and installs or removes one. Any signed-in connection may ask, as for
// `update.apply`: a token already holds shell-level power on this machine, and the server never
// runs what is installed (a client does, once its user picks the theme). `plugins.remoteInstall:
// false` in the config leaves installing to the command on the machine.
import { PLUGIN_ID_RE } from '../../../src/shared/plugins/manifest.ts'
import { codedError } from '../errors.ts'
import type { V2Context } from '../v2.ts'
import { presenceOf } from './installed.ts'
import { fetchPluginPackage, parsePluginPackageText } from './source.ts'

type Handler = (params: any, ctx: V2Context) => unknown

function installed(ctx: V2Context): NonNullable<V2Context['installed']> {
  if (!ctx.installed) throw codedError('NOT_FOUND', 'This server does not keep installed plugins')
  return ctx.installed
}

/** The same, on a server that takes installs from its clients. */
function writable(ctx: V2Context): NonNullable<V2Context['installed']> {
  const service = installed(ctx)
  if (!service.remoteInstall()) {
    throw codedError('NOT_FOUND', 'This server does not install or remove plugins for a client (plugins.remoteInstall is false in its config): run `trek-server plugin add` or `trek-server plugin remove` on its machine')
  }
  return service
}

const MAX_URL_CHARS = 2048

/** The `id` asked about: a plugin id by its form, so a message that names it sends back nothing else. */
function idOf(p: unknown): string {
  const id = (p as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !id) throw codedError('BAD_REQUEST', 'id is required')
  if (!PLUGIN_ID_RE.test(id)) throw codedError('BAD_REQUEST', 'id is not a plugin id')
  return id
}

export const pluginInstallHandlers: Record<string, Handler> = {
  'plugins.bundle': (p, ctx) => {
    const id = idOf(p)
    const bundle = installed(ctx).store.bundle(id)
    if (!bundle) throw codedError('NOT_FOUND', `No installed plugin with id "${id}"`)
    return bundle
  },
  'plugins.install': async (p, ctx) => {
    const service = writable(ctx)
    const url: unknown = p?.url
    const text: unknown = p?.package
    if ((url === undefined) === (text === undefined)) throw codedError('BAD_REQUEST', 'Give one of url or package')
    if (url !== undefined && typeof url !== 'string') throw codedError('BAD_REQUEST', 'url must be a string')
    if (typeof url === 'string' && url.length > MAX_URL_CHARS) throw codedError('BAD_REQUEST', 'url is longer than 2,048 characters')
    if (text !== undefined && typeof text !== 'string') throw codedError('BAD_REQUEST', "package must be a string (the .trekplugin file's text)")
    const pkg = typeof url === 'string' ? await fetchPluginPackage(url, service.fetch) : parsePluginPackageText(text as string)
    return presenceOf(service.store.add(pkg))
  },
  'plugins.remove': (p, ctx) => {
    const service = writable(ctx)
    const id = idOf(p)
    if (!service.store.remove(id)) throw codedError('NOT_FOUND', `No installed plugin with id "${id}"`)
    return {}
  }
}
