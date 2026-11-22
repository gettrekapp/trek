// The campsite plugin's server half (campsite part 2): the shared camp — what real work earns, the
// crew sessions borrow — kept in camp.json and sent to every project's windows (server/camp.ts).
import { defineServerPlugin } from '../../../src/shared/plugins/server.ts'
import { CAMPSITE_MANIFEST } from '../manifest.ts'
import { createCampServer } from './camp.ts'

export const campsiteServerPlugin = defineServerPlugin({
  manifest: CAMPSITE_MANIFEST,
  setup: (host) => createCampServer(host)
})
