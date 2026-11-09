// The store patches a server window applies as it takes over the window and as
// it leaves its project. Pure: installV2.ts applies them.
import { OFF_VIEW } from '../../../shared/bot.ts'
import type { AppState } from '../store'

/** The projected slice and the window's server-mode state, emptied. */
export const EMPTY: Partial<AppState> = {
  project: null,
  activeWorktreeId: null,
  selected: null,
  terminals: {},
  terminalOrder: {},
  activeTerminal: {},
  loadedWorktrees: {},
  hostWorktrees: {},
  terminalQueues: {},
  decisions: {},
  serverOffline: false,
  serverLink: null,
  serverAgents: null
}

/**
 * View state a window keeps from what it showed before (a file window's open
 * Global panel or bot tab, its bot, Colima environments and tool check, Linear chips): a
 * server window starts from none of it and leaves none behind. The voice
 * queue is stopped rather than zeroed here (`stopAllSummaries`), so what the
 * store shows stays what plays. The queue panels' open state is an app-wide
 * preference and stays.
 */
export const VIEW_RESET: Partial<AppState> = {
  globalPanelOpen: false,
  globalView: 'sessions',
  botView: OFF_VIEW,
  botEvents: [],
  serverStatus: {},
  environments: {},
  envBusy: {},
  envToolCheck: null,
  linearIssues: {}
}

/** On install: the setter overrides and the view reset; offline until ServerProjectWindow reports the real status. */
export function installPatch(overrides: Partial<AppState>): Partial<AppState> {
  return { ...overrides, ...VIEW_RESET, serverOffline: true, serverLink: null }
}

/** On leave: the store's own setters back, the slice emptied and the view reset. */
export function leavePatch(originals: Partial<AppState>): Partial<AppState> {
  return { ...originals, ...EMPTY, ...VIEW_RESET }
}
