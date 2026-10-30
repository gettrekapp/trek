import type { RendererApi } from '../../preload/index'

declare global {
  interface Window {
    api: RendererApi
  }
}

export {}
