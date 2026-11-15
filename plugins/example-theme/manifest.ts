// The example theme's manifest (theme plugins phase 2): the one source for its package's
// manifest.json and for the plugin its bundle exports. The two must name the same id and version.
import type { PluginManifest } from '../../src/shared/plugins/manifest.ts'

export const manifest: PluginManifest = {
  id: 'example-theme',
  version: '1.0.0',
  name: 'Example theme',
  description: 'A blue-tinted look: the reference theme for plugin authors.',
  defaultEnabled: false,
  type: 'theme',
  contract: 1
}
