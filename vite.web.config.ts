// The web client (5c-3): a browser build of the v2 project window, written to
// server/dist/web-client, where `trek-server start --web` serves it. The
// Electron renderer's build (electron.vite.config.ts) is unchanged.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  base: '/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./server/dist/web-client', import.meta.url)),
    emptyOutDir: true,
    // Every asset is a file under assets/ (the server caches those for good): nothing inlined.
    assetsInlineLimit: 0,
    sourcemap: false,
    // The window is one big chunk (as in the Electron renderer), plus lazy chunks such as the
    // campsite's Pixi renderer, loaded when the strip first opens.
    chunkSizeWarningLimit: 2000
  }
})
