// A theme with JSX, a hook and the plugin host: the fixture that shows a built bundle uses the
// window's React and the window's PluginHostContext (scripts/exampleTheme.test.mjs).
import { useState } from 'react'
import { defineClientPlugin, usePluginHost } from '../../../src/shared/plugins/client.ts'

function Badge() {
  const host = usePluginHost()
  const [count] = useState(2)
  return (
    <span data-badge>
      {host.id}:{count}
    </span>
  )
}

export default defineClientPlugin({
  manifest: { id: 'jsx-theme', version: '0.1.0', name: 'JSX theme', description: 'A fixture.', defaultEnabled: false, type: 'theme', contract: 1 },
  theme: { styles: ':root{--accent:#f0f}' },
  slots: { overlay: Badge }
})
