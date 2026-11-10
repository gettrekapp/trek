// The web client's entry (5c-3): `window.api` first (installApi.ts), then the
// renderer's styles and the page shell.
import { web } from './installApi.ts'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ErrorBoundary } from '../renderer/src/components/ErrorBoundary'
import { followWindowKind } from '../renderer/src/windowKind'
import { WebApp } from './WebApp.tsx'
import '@xterm/xterm/css/xterm.css'
import '../renderer/src/styles.css'
import './web.css'

// The backend follows the store's serverWindow, as in an Electron window.
followWindowKind()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <WebApp web={web} />
    </ErrorBoundary>
  </React.StrictMode>
)
