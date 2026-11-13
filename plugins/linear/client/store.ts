// The Linear plugin's state in this window: whether the window's server has a key.
import { create } from 'zustand'

interface LinearState {
  /** The window's server has a Linear API key (server-wide, not per project) */
  connected: boolean
  setConnected(connected: boolean): void
}

export const useLinearStore = create<LinearState>((set) => ({
  connected: false,
  setConnected: (connected) => set({ connected })
}))
