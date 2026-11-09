// The start screen's guard for a project being created in this window (4e-2 Decision 12, Risk 9).
// A menu's view switch while a create is in flight would unmount the New Project dialog and the
// view that opens the project, so the project would be created and not opened, and a failed open's
// error would be set on an unmounted component. The count holds from `project.create` until the
// project's open has settled too. Pure: imported by tests.

let inFlight = 0

/** A create, or the open that follows it, is in flight in this window. */
export const createInFlight = (): boolean => inFlight > 0

/** Runs `run` (a create and its open) with the count held until it settles, resolved or rejected. */
export async function whileCreating<T>(run: () => Promise<T>): Promise<T> {
  inFlight++
  try {
    return await run()
  } finally {
    inFlight--
  }
}
