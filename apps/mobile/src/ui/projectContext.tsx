// The open project's ids, from the project layout. The list screen cannot read them from its own
// route: when a screen is opened from outside (Needs you, a notification) the list is built beneath
// it as an anchor, and an anchor carries no params. The layout's own route always has them.
import { createContext, useContext } from 'react'

export type ProjectIds = { serverId: string; projectId: string }

const Context = createContext<ProjectIds | null>(null)

export const ProjectProvider = Context.Provider

export function useProjectIds(): ProjectIds {
  const ids = useContext(Context)
  if (!ids) throw new Error('useProjectIds is used outside the project layout')
  return ids
}
