// When a terminal's plugin overlay steps back: while the user scrolls back
// through the output, and for a moment after each key (`typing`, held DIM_AFTER_KEY_MS). Never
// while nothing fills the overlay (`enabled` false). Pure.
export const DIM_AFTER_KEY_MS = 3000

export function overlayDimmed(state: { typing: boolean; scrolledUp: boolean; enabled?: boolean }): boolean {
  return state.enabled !== false && (state.typing || state.scrolledUp)
}
