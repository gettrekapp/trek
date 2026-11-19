// The GitHub plugin (plugins P3): pull request links, labels and the watch's reads through gh on the
// server's machine. Built into Trek; before P3 the core did this itself.
import type { PluginManifest } from '../../src/shared/plugins/manifest.ts'

export const GITHUB_MANIFEST: PluginManifest = {
  id: 'github',
  version: '1.0.0',
  name: 'GitHub',
  description: 'Link worktree branches to GitHub pull requests, and watch their checks, reviews and merge state through gh on the server.',
  defaultEnabled: true,
  // A server older than plugins handled GitHub pull requests itself, with no capability saying so.
  legacyBuiltIn: true
}
