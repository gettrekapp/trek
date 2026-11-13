// Options every child process of the server's code gets. windowsHide: on Windows a console
// program started from a process without a console (the detached local server, a service)
// gets a console window of its own, so every git poll would flash one. A no-op elsewhere.
// scripts/childOptions.test.mjs checks that each spawn/execFile in server/src and src/host
// passes its options through hidden().

/** `opts` with `windowsHide: true`. */
export function hidden<T extends object>(opts: T): T & { windowsHide: true } {
  return { ...opts, windowsHide: true }
}
