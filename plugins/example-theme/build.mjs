// Builds a theme plugin into a .trekplugin package (theme plugins phase 2): one ES module with no
// imports left. `react`, `react/jsx-runtime` and Trek's plugin contract are not bundled: they read
// from globalThis.__trekPlugin, which the window sets before it imports any bundle, so the plugin
// shares the window's React and the window's PluginHostContext.
//
// Run: node plugins/example-theme/build.mjs   → plugins/example-theme/dist/example-theme.trekplugin
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as client from '../../src/shared/plugins/client.ts'
import { manifest } from './manifest.ts'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The three modules a plugin shares with the window, by the name they have on
 * globalThis.__trekPlugin. The names each one exports are read from this build's own copies.
 */
const shared = { React, jsxRuntime, client }

/**
 * An ES module that re-exports the window's copy of a shared module, name by name. An ES module,
 * not `module.exports = …`: esbuild wraps a CommonJS module in its `__require` helper, and a
 * bundle must have nothing that reads as a require left in it. Each read is marked pure, so the
 * names a plugin does not import are dropped from its bundle.
 */
function sharedModule(name) {
  const names = Object.keys(shared[name]).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n))
  return [
    `const shared = globalThis.__trekPlugin.${name}`,
    'export default shared',
    ...names.map((n) => `export const ${n} = /* @__PURE__ */ Reflect.get(shared, '${n}')`)
  ].join('\n')
}

const trekExternals = {
  name: 'trek-externals',
  setup(b) {
    b.onResolve({ filter: /^react$/ }, () => ({ path: 'React', namespace: 'trek-global' }))
    b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsxRuntime', namespace: 'trek-global' }))
    b.onResolve({ filter: /(^|\/)shared\/plugins\/client(\.ts)?$/ }, () => ({ path: 'client', namespace: 'trek-global' }))
    b.onLoad({ filter: /.*/, namespace: 'trek-global' }, (args) => ({ contents: sharedModule(args.path), loader: 'js' }))
  }
}

/** The package of a plugin: `manifest`'s installable fields and the bundle of `entry`. */
export async function buildPlugin({ entry, manifest: m }) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    logLevel: 'silent',
    plugins: [trekExternals]
  })
  return {
    manifest: { id: m.id, version: m.version, name: m.name, description: m.description, type: m.type, contract: m.contract },
    client: result.outputFiles[0].text
  }
}

export const buildExampleTheme = () => buildPlugin({ entry: join(here, 'client', 'index.ts'), manifest })

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = await buildExampleTheme()
  const out = join(here, 'dist', `${pkg.manifest.id}.trekplugin`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(pkg))
  console.log(`${out}\nInstall it with: trek-server plugin add ${out}   (add --local for the app's Local server)`)
}
