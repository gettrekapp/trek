import { useAppStore } from './store'

/** Hides or shows this window's sidebar, and tells main so the window comes back that way. */
export function applySidebarHidden(hidden: boolean): void {
  useAppStore.getState().setSidebarHidden(hidden)
  window.api.setSidebarHidden(hidden)
}

/** View → Toggle Sidebar, and the two buttons. */
export function toggleSidebar(): void {
  applySidebarHidden(!useAppStore.getState().sidebarHidden)
}
