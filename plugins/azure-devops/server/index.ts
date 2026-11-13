// The Azure DevOps plugin's server half: its tickets (set_worktree_ticket) and its project setting's check.
import { defineServerPlugin } from '../../../src/shared/plugins/server.ts'
import { AZURE_DEVOPS_MANIFEST } from '../manifest.ts'
import { BASE_URL_SETTING, azureDevOpsTickets, baseUrlProblem } from '../shared/ticket.ts'

export const azureDevOpsServerPlugin = defineServerPlugin({
  manifest: AZURE_DEVOPS_MANIFEST,
  setup: () => ({
    handlers: {},
    ticketProvider: azureDevOpsTickets,
    checkProjectSetting: (key, value) => (key === BASE_URL_SETTING ? baseUrlProblem(value) : null)
  })
})
