// The ids an installed plugin may not take (theme plugins phase 1): a built-in plugin's, and the
// namespaces of the core methods, as for a built-in (registry.ts).
import { isCoreMethod } from '../v2.ts'
import { RESERVED_IDS } from './registry.ts'

export function installedIdReserved(builtIns: readonly { manifest: { id: string } }[]): (id: string) => boolean {
  const builtInIds = new Set(builtIns.map((p) => p.manifest.id))
  return (id) => builtInIds.has(id) || RESERVED_IDS.has(id) || isCoreMethod(`${id}.`)
}
