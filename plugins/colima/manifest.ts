// The Colima environments plugin (plugins E2): one Colima VM per worktree's branch, with docker
// compose inside it, on the server's machine. Built into Trek; before E2 the core did this itself.
// Its id is `env` so its methods keep their wire names (env.up, env.list, …, event env.log).
import type { PluginManifest } from '../../src/shared/plugins/manifest.ts'

export const COLIMA_MANIFEST: PluginManifest = {
  id: 'env',
  version: '1.0.0',
  name: 'Colima environments',
  description: "Run each worktree's docker compose in its own Colima VM on the server's machine (macOS and Linux).",
  defaultEnabled: true,
  // A server older than plugins served env.* itself and said so with the `env` capability.
  legacyCapability: ['env'],
  legacyBuiltIn: true,
  // Colima runs only on macOS and Linux: a Windows server lists it as not available.
  platforms: ['darwin', 'linux'],
  // What core stored in Repository.environments and BranchData.env before E2, kind for kind
  // (server/src/projects/legacyEnv.ts mirrors them; scripts/legacyEnvSettings.test.mjs checks they match).
  repoSettings: {
    enabled: 'boolean',
    cpu: 'number',
    memory: 'number',
    disk: 'number',
    networkAddress: 'boolean',
    rosetta: 'boolean',
    composeFile: 'string',
    profileKey: 'string'
  },
  branchSettings: { env: 'text' }
}
