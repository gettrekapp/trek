// The campsite plugin's client half: hikers on the session tabs, on the terminals' button rows and at the
// campsite strip, and its Settings section.
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { CAMPSITE_MANIFEST } from '../manifest.ts'
import './campsite.css'
import { Campsite } from './Campsite.tsx'
import { CampsiteSettings } from './Settings.tsx'
import { SessionIndicator } from './SessionIndicator.tsx'
import { TerminalHiker } from './TerminalHiker.tsx'

export const campsiteClientPlugin = defineClientPlugin({
  manifest: CAMPSITE_MANIFEST,
  slots: { sessionIndicator: SessionIndicator, terminalBarEnd: TerminalHiker, bottomBar: Campsite, settings: CampsiteSettings }
})
