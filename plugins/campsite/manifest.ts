// The campsite plugin: a pixel-art hiker for each agent session, on its tab, in its terminal's
// corner and at a campsite along the bottom of the window.
import type { PluginManifest } from '../../src/shared/plugins/manifest.ts'

export const CAMPSITE_MANIFEST: PluginManifest = {
  id: 'campsite',
  version: '1.0.0',
  name: 'Campsite',
  description: "Each agent session is a hiker: on its tab, in its terminal's corner and at a campsite along the bottom of the window, where those who need you wave by the fire.",
  defaultEnabled: true
}
