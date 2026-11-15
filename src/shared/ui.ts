// What a client shows, as it tells the server (`ui.report`), and the server asking one client to
// show a session (`ui.focus`): behind the MCP tools get_selected_worktree and focus_session.

/** The kind of client a connection is, as the server tells it at hello. */
export type UiClientKind = 'desktop' | 'web' | 'phone'

/** `ui.report`: the selection of this connection's client in a project. */
export interface UiReportParams {
  projectId: string
  /** The selected worktree; null or absent: none, or the Global panel */
  worktreeId?: string | null
  /** The session tab shown; null or absent: none. With no worktree it is a Global session */
  sessionId?: string | null
  /**
   * Whether the user is using this client now (absent: true). Only such a report makes the client
   * the project's most recently used; false is for a selection that changed without the user
   * (a window in the background, a reconnect) and only updates what the client shows
   */
  active?: boolean
}

/** `ui.focus`: show this session. Sent to one connection, the project's most recently used client. */
export interface UiFocusEvent {
  projectId: string
  worktreeId: string
  sessionId: string
}

/** An id in a report: at most this many characters */
export const MAX_UI_ID = 200
