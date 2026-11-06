// Which URLs a window may load itself, and which links go to the browser. Pure.
// Windows carry the full preload api (including the relay to authenticated servers),
// so only the app's own renderer may ever be loaded into one.
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * True when `url` is the app's own renderer: in dev, the same origin as the dev
 * server (`devUrl`, from ELECTRON_RENDERER_URL); in a build, a file inside
 * `rendererDir`, the directory holding the renderer's index.html.
 */
export function isAppUrl(url: string, devUrl: string | null, rendererDir: string): boolean {
  const target = parse(url)
  if (!target) return false
  if (devUrl) {
    const dev = parse(devUrl)
    return dev !== null && /^https?:$/.test(dev.protocol) && target.origin === dev.origin
  }
  if (target.protocol !== 'file:' || target.host !== '') return false
  let path: string
  try {
    path = fileURLToPath(target)
  } catch {
    return false
  }
  const rel = relative(resolve(rendererDir), resolve(path))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Links the app hands to the system browser; any other scheme is dropped. */
export function isExternalUrl(url: string): boolean {
  const target = parse(url)
  return target !== null && (target.protocol === 'http:' || target.protocol === 'https:')
}
