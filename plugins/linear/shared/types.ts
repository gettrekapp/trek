// The Linear plugin's wire types (phase 5b's linear.*, unchanged on the wire).

/** A Linear issue's live title and workflow state, fetched for ticket chips. */
export interface LinearIssue {
  identifier: string
  title: string
  url: string
  /** Workflow state, e.g. "In Progress" */
  status: string
  /** Linear's state category: triage, backlog, unstarted, started, completed, canceled */
  statusType: string
  /** Hex color Linear uses for the state */
  statusColor: string
}

/** `present`: a set-if-absent (the app's hand-over) found a key already stored, and kept it. */
export type LinearKeyResult = { ok: true; user: string } | { ok: false; error: string; present?: true }
