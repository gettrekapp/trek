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

/** An empty window: no project, so nothing to do. */
export const NO_FEATURES: BackendFeatures = Object.fromEntries(FEATURE_NAMES.map((name) => [name, false])) as Record<FeatureName, boolean>

/**
 * A server window (3c-2, 4c, 5a). The ceiling: the v2 backend's features are
 * these AND what `v2Features` asks of the server's welcome and the window's entry.
 * - Off: the bot and voice (phase 5) and the git flows protocol v2 has no
 *   command for (moving a worktree, promote).
 * - Settings are edited on the server (every v2 server has
 *   project.updateSettings, so no capability), with the sections
 *   `settingsSections` picks.
 * - Linear only reads ticket ids, with this machine's API key: on for every
 *   server (4c).
 * - The Global panel needs `mcp`.
 * - Docker, environments and stacks run on the server's machine (5a): each
 *   needs its capability, on any server.
 * - Skills, Reveal and Open in VS Code read or open things on this machine at
 *   the project's paths: only the Local server's paths are on this disk
 *   (`MACHINE_FEATURES`).
 */
export const V2_FEATURES: BackendFeatures = {
  docker: true,
  env: true,
  stacks: true,
  bot: false,
  linear: true,
  voice: false,
  skills: true,
  moveWorktree: false,
  reveal: true,
  openInEditor: true,
  promote: false,
  settingsEdit: true,
  globalPanel: true
}

/**
 * The welcome capability a v2 feature needs, if any. Global sessions drive the
 * worktree sessions through the server's MCP tools, so without `mcp` they
 * could not do their job. Docker, the environments and the stacks are the
 * server's own methods (5a): a server older than them has none of the three.
 */
const CAPABILITY_FOR: Partial<Record<FeatureName, string>> = {
  globalPanel: 'mcp',
  docker: 'docker',
  env: 'env',
  stacks: 'stacks'
}

/**
 * The features that use the project's paths on this machine (Electron main
 * reads or opens them). A server window has them only on the Local entry (the
 * supervisor's own server, which main found by its pid and profile) when its
 * welcome says `local` too. Never by the capability alone: a saved entry can
 * reach another machine's Local server through a tunnel, still on 127.0.0.1,
 * and its paths are not here. Skills move to the server in 5b.
 */
export const MACHINE_FEATURES: readonly FeatureName[] = ['skills', 'reveal', 'openInEditor']

/** The `local` welcome capability (CAPABILITY.local in shared/protocolV2.ts). */
const LOCAL_CAPABILITY = 'local'

export interface V2FeatureOptions {
  /** The window's entry is the Local server's (`LOCAL_ENTRY_ID`) */
  localEntry?: boolean
}

const v2ByCapabilities = new Map<string, BackendFeatures>()

/**
 * A server window's features: `V2_FEATURES` AND the welcome's capabilities
 * (none before the first welcome), with the machine-local ones only on this
 * machine's Local server. The same inputs give the same object, so
 * `useFeatures` can hand it to React as a stable snapshot.
 */
export function v2Features(capabilities: readonly string[] | undefined, options: V2FeatureOptions = {}): BackendFeatures {
  const caps = [...new Set(capabilities ?? [])].sort()
  const machine = options.localEntry === true && caps.includes(LOCAL_CAPABILITY)
  const key = `${machine ? 'machine' : ''}\n${caps.join('\n')}`
  let features = v2ByCapabilities.get(key)
  if (!features) {
    const out = {} as Record<FeatureName, boolean>
    for (const name of FEATURE_NAMES) {
      const needs = CAPABILITY_FOR[name]
      out[name] =
        V2_FEATURES[name] &&
        (needs === undefined || caps.includes(needs)) &&
        (machine || !MACHINE_FEATURES.includes(name))
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

/** The Settings panel's sections, in panel order. */
export const SETTINGS_SECTIONS = [
  'sessionMode',
  'audioAlerts',
  'linkedDirs',
  'appearance',
  'linear',
  'voice',
  'agents',
  'worktreeTags',
  'customTags',
  'terminalButtons',
  'sessionPrompt',
  'globalPrompt',
  'globalButtons',
  'sessionTypes',
  'environments'
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/**
 * How a section shows: `edit`, the whole section; `project` only the
 * project's part, with a hint that the rest is the server's config (the
 * agents: the server's default and its provider commands are its `llm`
 * section, which the protocol does not edit); `hidden`.
 */
export type SectionMode = 'edit' | 'project' | 'hidden'

/**
 * Which Settings sections a window shows. A server window edits the project's
 * settings on the server and hides what belongs to this machine: the voice API
 * keys. Linear (its key is app-wide, in main) shows where the window has the
 * feature (every server), and the Docker environments where it has `env` (a
 * server that runs them, on its own machine).
 */
export function settingsSections(features: BackendFeatures): Readonly<Record<SettingsSection, SectionMode>> {
  const out = {} as Record<SettingsSection, SectionMode>
  for (const name of SETTINGS_SECTIONS) out[name] = 'edit'
  if (!features.linear) out.linear = 'hidden'
  out.voice = 'hidden'
  if (!features.env) out.environments = 'hidden'
  out.agents = 'project'
  return out
}
