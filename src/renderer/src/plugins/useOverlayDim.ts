// A terminal pane's plugin overlay dim (campsite's hiker): on while the pane is scrolled back,
// and for DIM_AFTER_KEY_MS after the last key. One debounced timer, so keys don't re-render the pane.
import { useCallback, useEffect, useRef, useState } from 'react'
import { onTerminalScroll } from '../terminals'
import { DIM_AFTER_KEY_MS, overlayDimmed } from './overlayDim.ts'

export function useOverlayDim(terminalId: string, visible: boolean): { dimmed: boolean; onKey: () => void } {
  const [typing, setTyping] = useState(false)
  const [scrolledUp, setScrolledUp] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => (visible ? onTerminalScroll(terminalId, setScrolledUp) : undefined), [terminalId, visible])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const onKey = useCallback((): void => {
    setTyping(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setTyping(false)
    }, DIM_AFTER_KEY_MS)
  }, [])
  return { dimmed: overlayDimmed({ typing, scrolledUp }), onKey }
}
