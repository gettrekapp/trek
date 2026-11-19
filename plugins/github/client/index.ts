// The GitHub plugin's client half: its pull request links, for the window's chips and dialogs.
import { defineClientPlugin } from '../../../src/shared/plugins/client.ts'
import { GITHUB_MANIFEST } from '../manifest.ts'
import { githubPrs } from '../shared/pr.ts'

export const githubClientPlugin = defineClientPlugin({ manifest: GITHUB_MANIFEST, prProvider: githubPrs })
