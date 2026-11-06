// What a window's backend can do beyond the common core (sessions, git, branch
// data). The UI hides a feature its backend lacks. Pure: imported by tests.

export type FeatureName =
  | 'docker'
  | 'env'
  | 'stacks'
  | 'bot'
  | 'linear'
  | 'voice'
  | 'skills'
  | 'moveWorktree'
  | 'reveal'
  | 'openInEditor'
  | 'promote'
  | 'settingsEdit'

export type BackendFeatures = Readonly<Record<FeatureName, boolean>>

export const FEATURE_NAMES: readonly FeatureName[] = [
  'docker',
  'env',
  'stacks',
  'bot',
  'linear',
  'voice',
  'skills',
  'moveWorktree',
  'reveal',
  'openInEditor',
  'promote',
  'settingsEdit'
]

/** A project file window runs everything on this machine: every feature. */
export const LEGACY_FEATURES: BackendFeatures = {
  docker: true,
  env: true,
  stacks: true,
  bot: true,
  linear: true,
  voice: true,
  skills: true,
  moveWorktree: true,
  reveal: true,
  openInEditor: true,
  promote: true,
  settingsEdit: true
}

/**
 * A server window (3c-2). Off: anything that reads or runs things on this
 * machine against the project's paths (the paths are on the server), the bot
 * and voice (local MCP tools), and the git flows protocol v2 has no command for.
 * Settings are read-only in v2. Linear stays: it only reads ticket ids from the
 * project and uses this machine's API key.
 */
export const V2_FEATURES: BackendFeatures = {
  docker: false,
  env: false,
  stacks: false,
  bot: false,
  linear: true,
  voice: false,
  skills: false,
  moveWorktree: false,
  reveal: false,
  openInEditor: false,
  promote: false,
  settingsEdit: false
}
