// A terminal pane's plugin overlay dim: on while the pane is scrolled back,
// and for DIM_AFTER_KEY_MS after the last key. One debounced timer, so keys don't re-render the pane.
// `enabled` false (no plugin fills terminalOverlay): no scroll subscription, keys do nothing, never dimmed.
import { useCallback, useEffect, useRef, useState } from 'react'
import { onTerminalScroll } from '../terminals'
import { DIM_AFTER_KEY_MS, overlayDimmed } from './overlayDim.ts'

export function useOverlayDim(terminalId: string, visible: boolean, enabled: boolean): { dimmed: boolean; onKey: () => void } {
  const [typing, setTyping] = useState(false)
  const [scrolledUp, setScrolledUp] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => (visible && enabled ? onTerminalScroll(terminalId, setScrolledUp) : undefined), [terminalId, visible, enabled])
  // Turned off (or unmounted): drop a pending key timer, and its typing with it
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setTyping(false)
    },
    [enabled]
  )
  const onKey = useCallback((): void => {
    if (!enabled) return
    setTyping(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setTyping(false)
    }, DIM_AFTER_KEY_MS)
  }, [enabled])
  return { dimmed: overlayDimmed({ typing, scrolledUp, enabled }), onKey }
}
