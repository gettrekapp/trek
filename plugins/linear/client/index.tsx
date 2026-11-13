// The Linear plugin's client half (plugin system phase 2; the renderer's Linear before it): its
// tickets for the window's chips and link dialog, the Runtime that looks their issues up with the
// server's key, and its Settings section (the key).
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { LINEAR_MANIFEST } from '../manifest.ts'
import { linearTickets } from '../shared/ticket.ts'
import { LinearRuntime } from './Runtime.tsx'
import { LinearSettings } from './LinearSettings.tsx'

export const linearClientPlugin = defineClientPlugin({
  manifest: LINEAR_MANIFEST,
  ticketProvider: linearTickets,
  Runtime: LinearRuntime,
  slots: { settings: LinearSettings }
})
