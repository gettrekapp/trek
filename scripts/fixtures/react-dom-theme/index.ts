// A fixture that must not build: react-dom is not one of the modules a plugin shares with the
// window, and a bundle may not carry its own copy.
import { createPortal } from 'react-dom'
import type { ClientPlugin } from '../../../src/shared/plugins/client.ts'

const plugin: ClientPlugin = {
  manifest: { id: 'react-dom-theme', version: '0.1.0', name: 'react-dom theme', description: 'A fixture.', defaultEnabled: false, type: 'theme', contract: 1 },
  theme: { styles: '' },
  slots: { overlay: () => createPortal(null, document.body) }
}

export default plugin
