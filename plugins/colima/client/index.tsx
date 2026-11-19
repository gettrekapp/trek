// The Colima environments plugin's client half (plugins E3; the window's own UI before): the Env
// panel in a worktree's Run menu, its header chip, the sidebar badge and hover row, Settings →
// Environments, the poll that feeds them (Runtime), and the old-server fallback's teardown.
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { COLIMA_MANIFEST } from '../manifest.ts'
import { EnvironmentPanel } from './EnvironmentPanel.tsx'
import { EnvironmentsSettings } from './EnvironmentsSettings.tsx'
import { colimaLegacyTeardown } from './legacyTeardown.ts'
import { envPanelEntry } from './panelEntry.ts'
import { ColimaRuntime } from './Runtime.tsx'
import { useColimaStore } from './store.ts'
import { EnvBadge, EnvChip, EnvHoverRow } from './worktreeSlots.tsx'

export const colimaClientPlugin = defineClientPlugin({
  manifest: COLIMA_MANIFEST,
  Runtime: ColimaRuntime,
  slots: {
    worktreePanel: {
      entry: envPanelEntry,
      subscribe: (listener) => useColimaStore.subscribe(() => listener()),
      Component: EnvironmentPanel
    },
    worktreeChip: EnvChip,
    sidebarBadge: EnvBadge,
    hoverRow: EnvHoverRow,
    repoSettings: { title: 'Environments', Component: EnvironmentsSettings }
  },
  legacyTeardown: colimaLegacyTeardown
})
