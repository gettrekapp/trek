// The GitHub plugin's server half (plugins P3).
import { defineServerPlugin } from '../../../src/shared/plugins/server.ts'
import { GITHUB_MANIFEST } from '../manifest.ts'
import { ghThroughHost } from './gh.ts'
import { createGithubPrProvider } from './provider.ts'

export const githubServerPlugin = defineServerPlugin({
  manifest: GITHUB_MANIFEST,
  setup: (host) => ({
    handlers: {},
    prProvider: createGithubPrProvider(ghThroughHost(host)),
    mcpInstructions:
      'Pull requests on GitHub: link one with its https://github.com/<owner>/<repo>/pull/<number> URL (or its number once another PR in the repository is linked); the server reads and watches it with gh signed in on its machine.'
  })
})
