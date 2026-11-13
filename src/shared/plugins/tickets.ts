// Ticket providers (plugin system phase 2): a tracker's ids, URLs and labels, as pure shared code.
// A provider plugin's server and client halves give the same object as `ticketProvider`; core's
// generic tickets (src/shared/tickets.ts) go through the ones on for the project.

/** A looked-up issue, for a chip's status and title (Linear's, through the client host's setTicketInfo). */
export interface TicketInfo {
  title: string
  status: string
  /** A CSS color for the status dot */
  statusColor: string
  /** The issue's own URL, when the tracker gives one */
  url?: string
}

export interface ParsedTicketInput {
  ticketId: string
  /** Project settings the input implies (a Linear URL's workspace, an Azure DevOps URL's base) */
  settings?: Record<string, string>
}

export interface TicketProvider {
  /** The plugin's id ('linear', 'azure-devops') */
  id: string
  /** What it takes, for a message or a placeholder: 'a Linear issue id (TOW-123) or issue URL' */
  hint: string
  /** Whether a stored ticket id is this provider's ('TOW-123'; '12345') */
  owns(ticketId: string): boolean
  /** An id or URL the user typed or pasted → its ticket id, and the project settings a URL implies; null when it isn't this tracker's */
  parse(input: string): ParsedTicketInput | null
  /** The chip's label ('TOW-123', '#12345') */
  label(ticketId: string): string
  /** Its browser URL from the project's settings (or a looked-up issue's own); null when it can't be built */
  url(settings: Readonly<Record<string, unknown>>, ticketId: string, info?: TicketInfo): string | null
  /** A ticket id a branch name embeds (Linear's default branch names: 'garrett/tow-123-fix-login'), for the link dialog to suggest */
  fromBranch?(branch: string): string | null
  /** The setting a bare id needs before it links (Linear's workspace slug); the link dialog asks for it, and checks it with `check` (its problem, or null) */
  linkSetting?: { key: string; label: string; placeholder: string; check?(value: string): string | null }
}

/** Types a provider. */
export const defineTicketProvider = (provider: TicketProvider): TicketProvider => provider
