import { useAppStore } from './store'

/** Hides or shows this window's sidebar, and tells main so the window comes back that way. */
export function applySidebarHidden(hidden: boolean): void {
  useAppStore.getState().setSidebarHidden(hidden)
  window.api.setSidebarHidden(hidden)
}

/** View → Toggle Sidebar, and the two buttons. A window with no project has no sidebar: nothing to toggle. */
export function toggleSidebar(): void {
  if (!useAppStore.getState().serverWindow) return
  applySidebarHidden(!useAppStore.getState().sidebarHidden)
}
