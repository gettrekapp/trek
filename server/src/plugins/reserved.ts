// The ids an installed plugin may not take (theme plugins phase 1): a built-in plugin's, the
// namespaces of the core methods, as for a built-in (registry.ts), and the names Windows keeps
// for devices: an id is a folder's name, and no folder there can be called `con` or `com1`.
import { isCoreMethod } from '../v2.ts'
import { RESERVED_IDS } from './registry.ts'

const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/

export function installedIdReserved(builtIns: readonly { manifest: { id: string } }[]): (id: string) => boolean {
  const builtInIds = new Set(builtIns.map((p) => p.manifest.id))
  return (id) => builtInIds.has(id) || RESERVED_IDS.has(id) || isCoreMethod(`${id}.`) || WINDOWS_DEVICE_RE.test(id)
}
