// The Colima plugin's settings under their names from before plugins E2, kept for one release
// cycle so older clients and older files keep working (remove with the old wire fields):
// - `Repository.environments` mirrors the `env` plugin's repo settings (`pluginSettings.env`);
// - `BranchData.env` mirrors its branch setting `env` (`pluginSettings.env.env`).
// The plugin's settings are what the server goes by. Every write to either side writes both
// (repo.update's `environments`, branch.setEnv, and repo/branch.setPluginSettings for `env`), and the
// old fields are saved too, so a server rolled back still has them. A project loaded, imported or
// moved in takes an old field that is present as written by an older Trek: it wins. Where it is
// absent but the plugin's copy is there, an older Trek cleared it (a server rolled back, then
// forward): no pre-E2 server writes `pluginSettings.env` itself (E1 refuses settings for a plugin
// it lacks; only a move or an import carries one by shape), and every E2 write keeps the two in
// step. So the plugin's copy goes too, or a cleared .env (secrets, maybe) would come back.
// `Project.envFieldsRetired` (E3's switch) turns that rule off: the plugin's value then stands and
// the mirror is made from it.
// Nothing here asks the registry: a server where the plugin is unavailable (Windows) keeps both.
// A write that would leave `pluginSettings` a map a move or an import refuses (over 1 MB of text in
// all, say) changes nothing and returns that problem.
import type { BranchData, Project, Repository } from '../../../src/shared/model/types'
import type { EnvironmentSettings } from '../../../src/shared/types'
import {
  MAX_PLUGIN_STRING,
  MAX_PLUGIN_TEXT,
  pluginSettingsShapeProblem,
  type PluginFieldKind,
  type PluginFieldValue,
  type PluginSettingValues
} from '../../../src/shared/plugins/manifest.ts'

/** The plugin whose settings the old fields mirror. */
export const LEGACY_ENV_PLUGIN = 'env'

/** Its repoSettings, kind for kind (scripts/legacyEnvSettings.test.mjs checks them against its manifest), in the old object's key order. */
export const LEGACY_ENV_REPO_FIELDS = {
  enabled: 'boolean',
  cpu: 'number',
  memory: 'number',
  disk: 'number',
  networkAddress: 'boolean',
  rosetta: 'boolean',
  composeFile: 'string',
  profileKey: 'string'
} as const satisfies Readonly<Record<string, PluginFieldKind>>

/** Its branch setting: the branch's .env text. */
export const LEGACY_ENV_BRANCH_FIELD = 'env'

type SettingsMap = Record<string, PluginSettingValues>

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function fits(kind: PluginFieldKind, value: unknown): value is PluginFieldValue {
  switch (kind) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
      return typeof value === 'string' && value.length <= MAX_PLUGIN_STRING && !/[\r\n]/.test(value)
    case 'text':
      return typeof value === 'string' && value.length <= MAX_PLUGIN_TEXT
  }
}

/** The plugin's own entry in stored `pluginSettings` (an own key holding an object only; a corrupt entry reads as none). */
export function envRepoValues(map: unknown): PluginSettingValues | undefined {
  if (!isPlain(map) || !Object.hasOwn(map, LEGACY_ENV_PLUGIN)) return undefined
  const values = map[LEGACY_ENV_PLUGIN]
  return isPlain(values) ? (values as PluginSettingValues) : undefined
}

/**
 * `map` with the plugin's entry set to `values`, or removed when there are none (`next` undefined
 * when that leaves it empty); or the problem the result would have.
 */
function withValues(map: SettingsMap | undefined, values: PluginSettingValues): { next: SettingsMap | undefined } | { problem: string } {
  if (map !== undefined && !isPlain(map)) return { problem: 'must be an object of plugin ids to values' }
  const next: SettingsMap = { ...(map ?? {}) }
  if (Object.keys(values).length > 0) next[LEGACY_ENV_PLUGIN] = { ...values }
  else delete next[LEGACY_ENV_PLUGIN]
  const problem = pluginSettingsShapeProblem(next)
  if (problem) return { problem }
  return { next: Object.keys(next).length > 0 ? next : undefined }
}

/** An old `environments` object as the plugin's values: its known fields of the right kind; anything else dropped. */
export function repoValuesFromLegacy(environments: unknown): PluginSettingValues {
  const out: PluginSettingValues = {}
  if (!isPlain(environments)) return out
  for (const [key, kind] of Object.entries(LEGACY_ENV_REPO_FIELDS)) {
    const value = environments[key]
    if (Object.hasOwn(environments, key) && fits(kind, value)) out[key] = value
  }
  return out
}

/**
 * The plugin's values once an old `environments` (or none: {}) is written: the old field's known
 * fields replace the plugin's; a value the old field cannot hold (from a later plugin version that
 * came in by a move or an import) is kept.
 */
export function repoValuesWithLegacy(current: PluginSettingValues | undefined, environments: unknown): PluginSettingValues {
  const out: PluginSettingValues = {}
  for (const [key, value] of Object.entries(current ?? {})) {
    if (!Object.hasOwn(LEGACY_ENV_REPO_FIELDS, key)) out[key] = value
  }
  return { ...out, ...repoValuesFromLegacy(environments) }
}

/** The plugin's values as the old `environments` (`enabled` always there); undefined when it has none of its fields. */
export function legacyFromRepoValues(values: PluginSettingValues | undefined): EnvironmentSettings | undefined {
  if (!values || !Object.keys(LEGACY_ENV_REPO_FIELDS).some((key) => Object.hasOwn(values, key))) return undefined
  const out: Record<string, PluginFieldValue> = { enabled: values.enabled === true }
  for (const key of Object.keys(LEGACY_ENV_REPO_FIELDS)) {
    if (key !== 'enabled' && Object.hasOwn(values, key)) out[key] = values[key]
  }
  return out as unknown as EnvironmentSettings
}

/** The repository's `environments`, made from its plugin values. */
export function mirrorRepo(repo: Repository): void {
  const legacy = legacyFromRepoValues(envRepoValues(repo.pluginSettings))
  if (legacy) repo.environments = legacy
  else delete repo.environments
}

/** Sets the repository's plugin values ({} clears them) and the mirror; or, changing nothing, the problem. */
export function setRepoEnv(repo: Repository, values: PluginSettingValues): string | null {
  const result = withValues(repo.pluginSettings, values)
  if ('problem' in result) return result.problem
  if (result.next) repo.pluginSettings = result.next
  else delete repo.pluginSettings
  mirrorRepo(repo)
  return null
}

/** The branch's `env`, made from its plugin value. */
export function mirrorBranch(data: BranchData): void {
  const text = envRepoValues(data.pluginSettings)?.[LEGACY_ENV_BRANCH_FIELD]
  if (typeof text === 'string' && text !== '') data.env = text
  else delete data.env
}

/**
 * Sets the branch's .env text (null clears it) in the plugin's values and the mirror; its other
 * values are kept. Or, changing nothing, the problem.
 */
export function setBranchEnv(data: BranchData, text: string | null): string | null {
  const { [LEGACY_ENV_BRANCH_FIELD]: _old, ...rest } = envRepoValues(data.pluginSettings) ?? {}
  const result = withValues(data.pluginSettings, text ? { ...rest, [LEGACY_ENV_BRANCH_FIELD]: text } : rest)
  if ('problem' in result) return result.problem
  if (result.next) data.pluginSettings = result.next
  else delete data.pluginSettings
  mirrorBranch(data)
  return null
}

const hasBranchCopy = (data: BranchData): boolean => envRepoValues(data.pluginSettings)?.[LEGACY_ENV_BRANCH_FIELD] !== undefined

/**
 * A branch's data from elsewhere (a file, an import, a move): its old `env`, when present, wins;
 * absent, the plugin's copy goes (an older Trek cleared it), unless `retired`. Or the problem,
 * changing nothing.
 */
export function migrateBranchEnv(data: BranchData, retired = false): string | null {
  const text = data.env
  if (typeof text === 'string' && text !== '') {
    if (text.length <= MAX_PLUGIN_TEXT) return setBranchEnv(data, text)
    // Past the plugin's limit (an older server took any length): kept as it is but not mirrored, so
    // the plugin does not apply it; the plugin's own copy (now out of step) goes.
    if (!hasBranchCopy(data)) return null
    const problem = setBranchEnv(data, null)
    data.env = text
    return problem
  }
  if (retired) {
    mirrorBranch(data)
    return null
  }
  delete data.env
  return hasBranchCopy(data) ? setBranchEnv(data, null) : null
}

/**
 * A repository from elsewhere: its old `environments`, when present, wins; then each branch. Each
 * part whose write would break the plugin settings' caps is left as it was and reported.
 */
export function migrateRepoEnv(repo: Repository, onProblem: (where: string, problem: string) => void = () => {}, retired = false): void {
  const current = envRepoValues(repo.pluginSettings)
  let problem: string | null = null
  if (repo.environments !== undefined) problem = setRepoEnv(repo, repoValuesWithLegacy(current, repo.environments))
  else if (retired) mirrorRepo(repo)
  // Absent: an older Trek cleared it. Its fields go from the plugin's copy; plugin-only ones stay.
  else if (current && Object.keys(current).some((key) => Object.hasOwn(LEGACY_ENV_REPO_FIELDS, key))) problem = setRepoEnv(repo, repoValuesWithLegacy(current, {}))
  if (problem) onProblem('pluginSettings', problem)
  if (!isPlain(repo.branchData)) return
  for (const [branch, data] of Object.entries(repo.branchData)) {
    if (!isPlain(data)) continue
    const branchProblem = migrateBranchEnv(data, retired)
    if (branchProblem) onProblem(`branchData[${JSON.stringify(branch)}].pluginSettings`, branchProblem)
    // An entry the migration emptied goes, as the methods drop one.
    else if (Object.keys(data).length === 0) delete repo.branchData[branch]
  }
}

/** Every repository of a project from elsewhere (store.ts's load, importCheck.ts), in place. */
export function migrateProjectEnv(project: Project, onProblem?: (where: string, problem: string) => void): Project {
  const retired = project.envFieldsRetired === true
  project.repositories.forEach((repo, i) => migrateRepoEnv(repo, (where, problem) => onProblem?.(`repositories[${i}].${where}`, problem), retired))
  return project
}
