import { useAppStore } from './store'
import { saveProject } from './persistence'
import { disposePendingTerminals } from './terminals'

/** Tells main what this window holds now: it decides where projects open from this. */
export function syncWindowProject(): void {
  const { project, filePath } = useAppStore.getState()
  window.api.reportWindowProject(!!project, filePath, project?.name ?? null)
}

export function watchWindowProject(): () => void {
  return useAppStore.subscribe((state, previous) => {
    if (
      !!state.project !== !!previous.project ||
      state.project?.name !== previous.project?.name ||
      state.filePath !== previous.filePath
    ) {
      syncWindowProject()
    }
  })
}

/** Agree to close: tabs that never got a session id can't be resumed, so they end first. */
function closeReady(): void {
  disposePendingTerminals()
  window.api.windowCloseReady()
}

/** Main asked to close the window: save what needs saving, then answer. */
export async function handleWindowCloseRequest(): Promise<void> {
  const state = useAppStore.getState()
  const hasSessions = Object.keys(state.terminals).length > 0
  if (!state.project || (!state.dirty && !hasSessions)) {
    closeReady()
    return
  }
  if (!state.filePath) {
    const choice = await window.api.promptCloseUnsaved(state.project.name)
    if (choice === 'discard') closeReady()
    if (choice === 'cancel') window.api.windowCloseCancelled()
    if (choice !== 'save') return
  }
  try {
    if (await saveProject()) closeReady()
    else window.api.windowCloseCancelled()
  } catch (err) {
    if (await window.api.promptCloseSaveFailed(String(err))) closeReady()
    else window.api.windowCloseCancelled()
  }
}
