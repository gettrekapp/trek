import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useAppStore } from './store'
import { attachedPty, readTerminal, terminalSize } from './terminals'
import { followWindowKind } from './windowKind'
import { getBackend } from './backend'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

// Exposed for debugging and smoke tests (local trusted app).
;(window as unknown as Record<string, unknown>).__store = useAppStore
;(window as unknown as Record<string, unknown>).__terminals = { attachedPty, readTerminal, terminalSize }
;(window as unknown as Record<string, unknown>).__features = () => getBackend().features
// The spoken summaries the window's backend hears (played or not); returns the unsubscribe.
;(window as unknown as Record<string, unknown>).__onVoiceSummary = (listener: (text: string) => void) => getBackend().voice.onSummary((e) => listener(e.text))

// For the window's lifetime: the backend follows serverWindow from the first set on.
followWindowKind()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
