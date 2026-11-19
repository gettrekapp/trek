// The Global tray's state for the open project: its height and the tab it shows, kept per project
// while the app runs (not across launches), so leaving a project and coming back finds the tray as
// it was. Screens reach it through useGlobalTray: `open` pulls the tray up on a session (a ui.focus,
// a notification), `where` says where a session is shown: the tray (a Global session that is not an
// automation's run), a screen, or not known yet (logic/globalTray.ts' focusPlace). The project layout provides it; ui/GlobalTray.tsx renders it.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { focusPlace, type TrayHeight } from '../logic/globalTray.ts'
import { useTopic } from '../state/hooks.ts'

interface TrayMemory {
  height: TrayHeight
  tab: string | null
}

const remembered = new Map<string, TrayMemory>()

export interface GlobalTrayControl {
  height: TrayHeight
  tab: string | null
  setHeight: (height: TrayHeight) => void
  setTab: (tab: string | null) => void
  /** Pull the tray up (to half, unless it is open already), on `sessionId` when given */
  open: (sessionId?: string) => void
  /** Where the session is shown: the tray, a screen, or not known yet (no snapshot, or not listed in it) */
  where: (sessionId: string) => 'tray' | 'screen' | 'unknown'
}

const Context = createContext<GlobalTrayControl | null>(null)

/** The open project's tray; null outside a project (nothing to open). */
export function useGlobalTray(): GlobalTrayControl | null {
  return useContext(Context)
}

export function GlobalTrayProvider({ serverId, projectId, children }: { serverId: string; projectId: string; children: React.ReactNode }): React.JSX.Element {
  const key = `${serverId}/${projectId}`
  const start = remembered.get(key) ?? { height: 'collapsed', tab: null }
  const [height, setHeightState] = useState<TrayHeight>(start.height)
  const [tab, setTabState] = useState<string | null>(start.tab)
  const topic = useTopic(serverId, `project:${projectId}`)
  // Read by `where`, which a focus listener holds: the latest project without a new function each snapshot.
  const project = useRef(topic.state === 'ready' ? topic.snapshot : null)
  project.current = topic.state === 'ready' ? topic.snapshot : null

  const setHeight = useCallback(
    (h: TrayHeight) => {
      setHeightState(h)
      remembered.set(key, { ...(remembered.get(key) ?? { tab: null }), height: h })
    },
    [key]
  )
  const setTab = useCallback(
    (t: string | null) => {
      setTabState(t)
      remembered.set(key, { ...(remembered.get(key) ?? { height: 'collapsed' }), tab: t })
    },
    [key]
  )
  const open = useCallback(
    (sessionId?: string) => {
      if (sessionId) setTab(sessionId)
      setHeight(height === 'collapsed' ? 'half' : height)
    },
    [height, setHeight, setTab]
  )
  const where = useCallback((sessionId: string) => focusPlace(project.current, sessionId), [])
  const value = useMemo(() => ({ height, tab, setHeight, setTab, open, where }), [height, tab, setHeight, setTab, open, where])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
