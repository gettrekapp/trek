// The Azure DevOps plugin's client half: its tickets, for the window's chips and link dialog.
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { AZURE_DEVOPS_MANIFEST } from '../manifest.ts'
import { azureDevOpsTickets } from '../shared/ticket.ts'

export const azureDevOpsClientPlugin = defineClientPlugin({
  manifest: AZURE_DEVOPS_MANIFEST,
  ticketProvider: azureDevOpsTickets
})
