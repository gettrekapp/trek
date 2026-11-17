// The width of the pane a screen is in: the window's on a phone, the detail pane's beside a
// project's sidebar. For a screen that sizes itself to the space it has.
import { createContext, useContext } from 'react'
import { useWindowDimensions } from 'react-native'

const PaneWidth = createContext<number | null>(null)

export const PaneWidthProvider = PaneWidth.Provider

export function usePaneWidth(): number {
  const pane = useContext(PaneWidth)
  const window = useWindowDimensions()
  return pane ?? window.width
}
