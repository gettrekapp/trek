// A list with a detail pane beside it, in a panel that may be too narrow for both: then the list
// fills it and a row opens its detail, with a way back (styles.css, `.list-detail`). This hook
// holds which of the two a narrow panel shows, and keeps the scroll position and the keyboard
// focus sensible when one replaces the other.
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ONE_PANE_BELOW_PX } from '../listDetail'

interface Options {
  /** Something is selected: without it there is no detail to show, whatever was opened before */
  hasSelection: boolean
  /** CSS selector of the scrolling ancestor of the root */
  scroller: string
  /** CSS selector, inside the root, of the selected row's button: what Back returns the focus to */
  selectedRow: string
}

export interface ListDetail {
  /** For the `.list-detail` element */
  root: RefObject<HTMLDivElement | null>
  /** For the `.list-detail-back` button */
  backButton: RefObject<HTMLButtonElement | null>
  /** A narrow panel shows the detail (the `detail-open` class); a wide one ignores it */
  showDetail: boolean
  /** A row was chosen: call it after selecting the row */
  open(): void
  /** The back button */
  back(): void
}

export function useListDetail({ hasSelection, scroller, selectedRow }: Options): ListDetail {
  const [detailOpen, setDetailOpen] = useState(false)
  // The selection can go while the detail is open (the window moved to another project): the list shows again.
  const showDetail = detailOpen && hasSelection
  const root = useRef<HTMLDivElement>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  /** Where the list was scrolled when a row was opened, put back when Back returns to it. */
  const listScroll = useRef(0)
  /**
   * The pane a click just swapped in, until the effect below has settled it. Swapping hides the
   * element that had the focus, which would drop the focus to the page. Null on the first render
   * and when the pane changes for another reason, so neither moves the focus.
   */
  const swapped = useRef<'detail' | 'list' | null>(null)
  const scrollEl = (): Element | null => root.current?.closest(scroller) ?? null
  // The root fills the container the stylesheet measures, so its width is the container's.
  const narrow = (): boolean => (root.current?.getBoundingClientRect().width ?? Infinity) < ONE_PANE_BELOW_PX

  useLayoutEffect(() => {
    const to = swapped.current
    swapped.current = null
    if (!to) return
    const el = scrollEl()
    if (to === 'detail') {
      // The detail starts at its top, not wherever the list was scrolled to.
      if (el) el.scrollTop = 0
      backButton.current?.focus({ preventScroll: true })
    } else {
      root.current?.querySelector<HTMLElement>(selectedRow)?.focus({ preventScroll: true })
      if (el) el.scrollTop = listScroll.current
    }
    // The selectors are constants of the page that calls this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDetail])

  const open = (): void => {
    // Two panes: the click only selects. Were it to open the detail too, narrowing the window
    // later would land on the detail instead of the list.
    if (!narrow()) {
      setDetailOpen(false)
      return
    }
    // Already on the detail (an Edit pressed there): the list's scroll position is the one saved
    // when the row was opened, and no pane swaps, so there is nothing for the effect to settle.
    if (showDetail) return
    listScroll.current = scrollEl()?.scrollTop ?? 0
    swapped.current = 'detail'
    setDetailOpen(true)
  }
  const back = (): void => {
    if (!detailOpen) return
    swapped.current = 'list'
    setDetailOpen(false)
  }
  return { root, backButton, showDetail, open, back }
}
