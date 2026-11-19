// The env plugin's settings under their names from before plugins E2: `Repository.environments`
// (its repo settings) and `BranchData.env` (its branch setting `env`). The server mirrors them for
// one more release (server/src/projects/legacyEnv.ts); a window reads and writes them itself on a
// server before E2, which keeps only these (v2/projector.ts, v2/settingsOverrides.ts). Field names
// and kinds only: nothing here runs or names a VM. Remove with the old wire fields.
import { MAX_PLUGIN_STRING, MAX_PLUGIN_TEXT, type PluginFieldKind, type PluginFieldValue, type PluginSettingValues } from './plugins/manifest.ts'
import type { EnvironmentSettings } from './types'

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

/** The plugin's values as the old `environments` (`enabled` always there); undefined when it has none of its fields. */
export function legacyFromRepoValues(values: PluginSettingValues | undefined): EnvironmentSettings | undefined {
  if (!values || !Object.keys(LEGACY_ENV_REPO_FIELDS).some((key) => Object.hasOwn(values, key))) return undefined
  const out: Record<string, PluginFieldValue> = { enabled: values.enabled === true }
  for (const key of Object.keys(LEGACY_ENV_REPO_FIELDS)) {
    if (key !== 'enabled' && Object.hasOwn(values, key)) out[key] = values[key]
  }
  return out as unknown as EnvironmentSettings
}
