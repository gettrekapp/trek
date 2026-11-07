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
  | 'globalPanel'

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
  'settingsEdit',
  'globalPanel'
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
  settingsEdit: true,
  globalPanel: true
}

/**
 * A server window (3c-2). Off: anything that reads or runs things on this
 * machine against the project's paths (the paths are on the server), the bot
 * and voice (local MCP tools), and the git flows protocol v2 has no command for.
 * Settings are read-only in v2, and Linear is hidden until phase 5 (the spec).
 * The Global panel is on, if the server has the capability it needs.
 * A ceiling: the v2 backend's features are these AND the server's welcome
 * capabilities (`v2Features`).
 */
export const V2_FEATURES: BackendFeatures = {
  docker: false,
  env: false,
  stacks: false,
  bot: false,
  linear: false,
  voice: false,
  skills: false,
  moveWorktree: false,
  reveal: false,
  openInEditor: false,
  promote: false,
  settingsEdit: false,
  globalPanel: true
}

/**
 * The welcome capability a v2 feature needs, if any. Global sessions drive the
 * worktree sessions through the server's MCP tools, so without `mcp` they
 * could not do their job.
 */
const CAPABILITY_FOR: Partial<Record<FeatureName, string>> = {
  globalPanel: 'mcp'
}

const v2ByCapabilities = new Map<string, BackendFeatures>()

/**
 * A server window's features: `V2_FEATURES` AND the welcome's capabilities
 * (none before the first welcome). The same capabilities give the same object,
 * so `useFeatures` can hand it to React as a stable snapshot.
 */
export function v2Features(capabilities: readonly string[] | undefined): BackendFeatures {
  const caps = [...new Set(capabilities ?? [])].sort()
  const key = caps.join('\n')
  let features = v2ByCapabilities.get(key)
  if (!features) {
    const out = {} as Record<FeatureName, boolean>
    for (const name of FEATURE_NAMES) {
      const needs = CAPABILITY_FOR[name]
      out[name] = V2_FEATURES[name] && (needs === undefined || caps.includes(needs))
    }
    features = out
    v2ByCapabilities.set(key, features)
  }
  return features
}

/**
 * How a window shows the Global panel. A server that lost its MCP listener
 * cannot give new Global sessions the tools they need, but the ones it already
 * runs keep going: they are shown, with no way to start another, rather than
 * left running unseen (Notes for 3c-3 #7).
 */
export function globalPanelMode(features: BackendFeatures, globalTabs: number): 'full' | 'readOnly' | 'hidden' {
  if (features.globalPanel) return 'full'
  return globalTabs > 0 ? 'readOnly' : 'hidden'
}
