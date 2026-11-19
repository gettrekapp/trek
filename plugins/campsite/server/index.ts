// The campsite plugin's server half: nothing to serve. It is registered so the server lists the
// plugin, which gives it the per-project on/off every plugin has.
import { defineServerPlugin } from '../../../src/shared/plugins/server.ts'
import { CAMPSITE_MANIFEST } from '../manifest.ts'

export const campsiteServerPlugin = defineServerPlugin({
  manifest: CAMPSITE_MANIFEST,
  setup: () => ({ handlers: {} })
})
