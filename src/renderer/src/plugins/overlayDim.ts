// When a terminal's plugin overlay (campsite's hiker) steps back: while the user scrolls back
// through the output, and for a moment after each key. Pure.
export const DIM_AFTER_KEY_MS = 3000

export function overlayDimmed(state: { lastKeyAt: number | null; now: number; scrolledUp: boolean }): boolean {
  if (state.scrolledUp) return true
  return state.lastKeyAt !== null && state.now - state.lastKeyAt < DIM_AFTER_KEY_MS
}
