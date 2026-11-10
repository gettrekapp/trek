// First import of the web client's entry (main.tsx): `window.api` must exist
// before any renderer module that reads it runs. ES modules evaluate in import
// order, so this runs before the rest of main.tsx's imports.
import { createWebApi } from './webApi.ts'

export const web = createWebApi()
window.api = web.api
