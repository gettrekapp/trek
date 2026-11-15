// What an installed plugin's bundle reads in place of its imports (theme plugins phase 2): the
// window's React, its JSX runtime and the plugin contract, so the plugin shares the window's
// React and the window's PluginHostContext. Set before any bundle is imported.
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as client from '../../../shared/plugins/client.ts'

export function exposePluginGlobals(): void {
  const scope = globalThis as { __trekPlugin?: unknown }
  scope.__trekPlugin ??= { React, jsxRuntime, client }
}
