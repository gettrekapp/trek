// scripts/prProviders.test.mjs — a window's PR providers (plugins P3): the github plugin's on a server
// that lists it and has it on for the project, and on a server older than plugins (legacyBuiltIn).
import test from 'node:test'
import assert from 'node:assert/strict'
// builtin.client.ts pulls in .tsx client halves, which plain Node can't load: the github half alone.
import { githubClientPlugin } from '../plugins/github/client/index.ts'
import { activePrProviders } from '../src/renderer/src/plugins/prProviders.ts'

const BUILTIN_CLIENT_PLUGINS = [githubClientPlugin]
const listed = (defaultEnabled = true) => ({ plugins: [{ id: 'github', version: '1.0.0', defaultEnabled }], capabilities: [] })

test('on by default where the server lists it; off by the project setting; on for an older server', () => {
  assert.deepEqual(activePrProviders(BUILTIN_CLIENT_PLUGINS, listed(), undefined).map((p) => p.id), ['github'])
  assert.deepEqual(activePrProviders(BUILTIN_CLIENT_PLUGINS, listed(), { github: { enabled: false } }), [])
  assert.deepEqual(activePrProviders(BUILTIN_CLIENT_PLUGINS, listed(false), undefined), [])
  assert.deepEqual(activePrProviders(BUILTIN_CLIENT_PLUGINS, { capabilities: [] }, undefined).map((p) => p.id), ['github'])
  assert.deepEqual(activePrProviders(BUILTIN_CLIENT_PLUGINS, undefined, undefined), [])
})

test('a provider whose id is not its plugin\'s is left out', () => {
  const odd = { ...githubClientPlugin, prProvider: { ...githubClientPlugin.prProvider, id: 'other' } }
  assert.deepEqual(activePrProviders([odd], listed(), undefined), [])
})
