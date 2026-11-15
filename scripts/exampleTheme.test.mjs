// scripts/exampleTheme.test.mjs — the example theme and its build (theme plugins phase 2): the
// package is installable, its bundle has no imports left, and it loads through the window's
// loader with the window's React and plugin contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import * as client from '../src/shared/plugins/client.ts'
import { checkPluginPackage } from '../src/shared/plugins/manifest.ts'
import { loadInstalledPlugin, sha256Hex } from '../src/renderer/src/plugins/installedLoader.ts'
import { buildExampleTheme, buildPlugin } from '../plugins/example-theme/build.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
const importText = (text) => import(dataUrl(`export * as ns from ${JSON.stringify(dataUrl(text))}`))

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

/** The example theme's bundle, built by a new process whose working directory is `cwd`. */
function buildFrom(cwd) {
  const script = `const { buildExampleTheme } = await import(${JSON.stringify(pathToFileURL(join(root, 'plugins/example-theme/build.mjs')).href)}); process.stdout.write((await buildExampleTheme()).client)`
  const run = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout
}

// esbuild names each module in a comment, relative to its working directory, which it takes once
// per process: so each build here is a process of its own, and one more is built after a chdir.
test('the build gives the same bundle from any working directory, with no path of this machine in it', async () => {
  const fromRepo = buildFrom(root)
  const fromElsewhere = buildFrom(tmpdir())
  assert.ok(fromRepo.includes('example-theme'))
  assert.equal(fromElsewhere, fromRepo)
  assert.equal(await sha256Hex(fromElsewhere), await sha256Hex(fromRepo))
  const here = process.cwd()
  let afterChdir
  try {
    process.chdir(tmpdir())
    afterChdir = (await buildExampleTheme()).client
  } finally {
    process.chdir(here)
  }
  assert.equal(afterChdir, fromRepo)
  for (const text of [fromRepo, fromElsewhere]) {
    assert.equal(text.includes(root), false, "the repo's path is not in the bundle")
    assert.equal(text.includes(root.replaceAll('\\', '/').replace(/^\//, '')), false, 'nor that path after a run of ../')
  }
})

test('a plugin that imports any other package is refused: nothing but the shared modules, never a private copy', async () => {
  const manifest = { id: 'react-dom-theme', version: '0.1.0', name: 'react-dom theme', description: 'A fixture.', type: 'theme', contract: 1 }
  await assert.rejects(buildPlugin({ entry: join(root, 'scripts/fixtures/react-dom-theme/index.ts'), manifest }), (err) => {
    assert.match(err.message, /a plugin may not import "react-dom"/)
    assert.match(err.message, /only react, react\/jsx-runtime and Trek's plugin contract/)
    return true
  })
})
