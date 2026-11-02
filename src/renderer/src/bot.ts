import type { BotAttach } from '../../shared/bot'
import { scheduleAutoSave } from './persistence'
import { useAppStore } from './store'
import { requestBotDecision } from './terminals'

/** What main was last asked to attach. Cleared to attach again when the request itself hasn't changed. */
let lastKey = ''

function attachRequest(): BotAttach | null {
  const { project, filePath } = useAppStore.getState()
  if (!project || !filePath) return null
  // Sent even while off: main records what Enable would be agreeing to.
  return {
    filePath,
    folder: project.bot?.folder,
    enabled: project.bot?.enabled ?? false,
    claudeCommand: project.claudeCommand?.trim() || 'claude',
    repoPaths: project.repositories.map((r) => r.path).filter(Boolean)
  }
}

async function syncBot(): Promise<void> {
  await window.api.botAttach(attachRequest())
  useAppStore.getState().setBotEvents(await window.api.botEvents())
}

function reportFailure(err: unknown): void {
  console.error('Project bot', err)
}

function syncIfChanged(): void {
  const key = JSON.stringify(attachRequest())
  if (key === lastKey) return
  lastKey = key
  void syncBot().catch(reportFailure)
}

/** Keeps the main process's bot matched to this window's project, and mirrors its state here. */
export function watchBot(): () => void {
  lastKey = ''
  // Compared with the last view, not the store: a dismissed flag stays dismissed.
  let lastDecision: string | null = null
  const unsubscribes = [
    useAppStore.subscribe((state, previous) => {
      if (
        state.project?.bot !== previous.project?.bot ||
        state.filePath !== previous.filePath ||
        state.project?.claudeCommand !== previous.project?.claudeCommand ||
        state.project?.repositories !== previous.project?.repositories ||
        !!state.project !== !!previous.project
      ) {
        syncIfChanged()
      }
    }),
    window.api.onBotView((view) => {
      const state = useAppStore.getState()
      state.setBotView(view)
      if (view.decision === lastDecision) return
      lastDecision = view.decision
      if (view.decision) requestBotDecision(view.decision)
      else state.setBotDecision(null)
    }),
    window.api.onBotEvent((event) => useAppStore.getState().addBotEvent(event))
  ]
  syncIfChanged()
  return () => unsubscribes.forEach((u) => u())
}

/** Agrees to the bot that main has on record for this window, and starts it. */
export async function allowBot(): Promise<void> {
  await window.api.botAllow()
  useAppStore.getState().setBotEvents(await window.api.botEvents())
}

/** Keeps any located folder. */
export async function enableBot(): Promise<void> {
  await window.api.botEnable()
  const { project, setBotSettings } = useAppStore.getState()
  // After a missing folder the settings can be unchanged, but main has let that bot go.
  lastKey = ''
  setBotSettings({ ...project?.bot, enabled: true })
  scheduleAutoSave()
}

/** Back to a default folder next to the project file, even if one was located. */
export async function startNewBot(): Promise<void> {
  await window.api.botStartNew()
  lastKey = ''
  useAppStore.getState().setBotSettings({ enabled: true })
  scheduleAutoSave()
}

export function disableBot(): void {
  const state = useAppStore.getState()
  state.setBotSettings({ ...state.project?.bot, enabled: false })
  scheduleAutoSave()
}

export async function locateBotFolder(): Promise<void> {
  const { folder, error } = await window.api.botLocate()
  if (error) throw new Error(error)
  if (!folder) return
  lastKey = ''
  useAppStore.getState().setBotSettings({ enabled: true, folder })
  scheduleAutoSave()
}

/** Tries again for a folder that was in use. Nothing tells this window when it comes free. */
export function retryBot(): void {
  lastKey = ''
  syncIfChanged()
}
