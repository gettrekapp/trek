// The build id baked into the bundle: a hash of the bundle itself, so two
// bundles share an id only if they are the same code. The bundle is built with
// BUILD_PLACEHOLDER where the id goes, hashed, then the placeholder is replaced.
import { createHash } from 'node:crypto'

export const BUILD_PLACEHOLDER = '__trek_server_build_placeholder__'

/** Returns the stamped bundle and its build id (12 hex digits). */
export function stampBuild(text) {
  if (!text.includes(BUILD_PLACEHOLDER)) throw new Error('the bundle has no build placeholder')
  const build = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
  return { text: text.replaceAll(BUILD_PLACEHOLDER, build), build }
}
