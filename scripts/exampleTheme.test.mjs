// scripts/exampleTheme.test.mjs — the example theme and its build (theme plugins phase 2): the
// package is installable, its bundle has no imports left, and it loads through the window's
// loader with the window's React and plugin contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import * as client from '../src/shared/plugins/client.ts'
import { checkPluginPackage } from '../src/shared/plugins/manifest.ts'
import { loadInstalledPlugin, sha256Hex } from '../src/renderer/src/plugins/installedLoader.ts'
import { buildExampleTheme, buildPlugin } from '../plugins/example-theme/build.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const importText = (text) => import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)

/** Loads a built package the way a window does. */
async function load(pkg) {
  globalThis.__trekPlugin = { React, jsxRuntime, client }
  const sha256 = await sha256Hex(pkg.client)
  const theme = { id: pkg.manifest.id, version: pkg.manifest.version, name: pkg.manifest.name, description: pkg.manifest.description, sha256, contract: pkg.manifest.contract }
  return loadInstalledPlugin(theme, sha256, { cache: new Map(), importText, request: async () => ({ sha256, client: pkg.client }) })
}

test('the example theme builds into a package the server would install', async () => {
  const pkg = await buildExampleTheme()
  const checked = checkPluginPackage(JSON.parse(JSON.stringify(pkg)))
  assert.equal(checked.problem, undefined)
  assert.deepEqual(checked.package.manifest, {
    id: 'example-theme',
    version: '1.0.0',
    name: 'Example theme',
    description: 'A blue-tinted look: the reference theme for plugin authors.',
    defaultEnabled: false,
    type: 'theme',
    contract: 1
  })
  assert.equal(/^\s*import[\s{'"]/m.test(pkg.client), false, 'no import statement left in the bundle')
  assert.equal(pkg.client.includes('require('), false, 'and no require')
  assert.ok(pkg.client.includes('globalThis.__trekPlugin'), 'React and the contract come from the window')
})

test('the built example theme loads through the loader: its manifest, its styles, its Runtime', async () => {
  const result = await load(await buildExampleTheme())
  assert.equal(result.kind, 'loaded', JSON.stringify(result))
  assert.equal(result.plugin.manifest.id, 'example-theme')
  assert.match(result.plugin.theme.styles, /:root\[data-theme='example-theme'\]/)
  assert.match(result.plugin.theme.styles, /--bg: #0f1420;/)
  assert.equal(typeof result.plugin.Runtime, 'function')
})

test("a built bundle's components use the window's React and plugin host context", async () => {
  const pkg = await buildPlugin({
    entry: join(root, 'scripts/fixtures/jsx-theme/index.tsx'),
    manifest: { id: 'jsx-theme', version: '0.1.0', name: 'JSX theme', description: 'A fixture.', type: 'theme', contract: 1 }
  })
  assert.equal(/^\s*import[\s{'"]/m.test(pkg.client), false)
  const result = await load(pkg)
  assert.equal(result.kind, 'loaded', JSON.stringify(result))
  const Overlay = result.plugin.slots.overlay
  // The Provider is the test's copy of the contract: the bundle reads the same context only if it did not bundle its own.
  const html = renderToStaticMarkup(React.createElement(client.PluginHostContext.Provider, { value: { id: 'jsx-theme' } }, React.createElement(Overlay)))
  assert.equal(html, '<span data-badge="true">jsx-theme:2</span>')
})
