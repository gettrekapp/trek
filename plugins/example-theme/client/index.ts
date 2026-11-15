// The example theme (theme plugins phase 2): the reference for plugin authors, and the tests'
// fixture. A theme is a ClientPlugin whose default export carries `theme.styles`; the window sets
// <html data-theme="<id>"> while it is active, so every rule here is scoped by it.
import { useEffect } from 'react'
import { defineClientPlugin, usePluginHost } from '../../../src/shared/plugins/client.ts'
import { manifest } from '../manifest.ts'

// The supported surface is the CSS variables on :root. Class names may change between releases.
const styles = `
:root[data-theme='example-theme'] {
  --bg: #0f1420;
  --bg-darker: #0a0e17;
  --bg-lighter: #1a2233;
  --panel: #161d2c;
  --surface: #26314a;
  --border: rgba(140, 170, 255, 0.12);
  --border-strong: rgba(140, 170, 255, 0.2);
  --text: #e6ebf5;
  --text-muted: rgba(214, 224, 255, 0.55);
  --accent: #7aa2ff;
}
`

/**
 * A theme may run code: its Runtime is mounted once while the theme is active, inside the
 * plugin's host. This one only marks <html> with the window's project, to show the shape.
 */
function Runtime(): null {
  const host = usePluginHost()
  useEffect(() => {
    document.documentElement.dataset.exampleTheme = host.projectId
    return () => {
      delete document.documentElement.dataset.exampleTheme
    }
  }, [host])
  return null
}

export default defineClientPlugin({ manifest, theme: { styles }, Runtime })
