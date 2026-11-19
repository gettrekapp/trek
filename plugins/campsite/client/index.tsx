// The campsite plugin's client half: hikers on the session tabs, in the terminal corners and at the
// campsite strip, and its Settings section.
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { CAMPSITE_MANIFEST } from '../manifest.ts'

export const campsiteClientPlugin = defineClientPlugin({
  manifest: CAMPSITE_MANIFEST,
  slots: {}
})
