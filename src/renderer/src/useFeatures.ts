// The current window backend's features, for components that read them while
// rendering: re-renders when the backend changes (the window's kind) and when
// a v2 backend's welcome capabilities arrive.
import { useSyncExternalStore } from 'react'
import { getBackend, subscribeBackend } from './backend'
import type { BackendFeatures } from './backendFeatures'

const features = (): BackendFeatures => getBackend().features

export function useFeatures(): BackendFeatures {
  return useSyncExternalStore(subscribeBackend, features)
}
