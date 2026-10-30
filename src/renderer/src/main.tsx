import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useAppStore } from './store'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

// Exposed for debugging and smoke tests (local trusted app).
;(window as unknown as Record<string, unknown>).__store = useAppStore

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
