# Multiple windows, one project each

## Goal

Let several Trek windows be open at once, each on its own project, with sessions
running independently. Today the app creates one window, and opening a project
replaces the current one and kills its sessions.

## Decisions

- **Architecture:** one app process with many windows. Each window already has its
  own renderer, so the store and terminals stay per-window with no changes.
- **A window holds at most one project, and a project file is open in at most one
  window.**
- **Opening never kills anything.** A project opens in a new window unless the
  current window is empty.
- **Closing auto-saves.** A project with a file is saved silently on close; only a
  never-saved project prompts.
- **Launch restores** the windows open at last quit, with sessions unloaded.

## Window registry

New `src/main/windows.ts` owns window creation (`createWindow` moves here from
`index.ts`) and tracks, per window, its project file path (or `null`) and optional
initial project path. No other main-process module tracks windows.

- The renderer collects its initial project on mount with
  `window:takeInitialProject`. If that file fails to open, it shows the error and
  stays on the start screen.
- The registry entry is cleared when the project closes, and updated when
  `project:save` writes to a new path.
- The native window title is set to the project name so the macOS Window menu can
  tell windows apart.

## Open flow

`project:open` and `project:openPath` decide in the main process, using a pure
function `decideOpen(filePath, senderHasProject, windowHoldingFile)`:

| Situation | Result |
|---|---|
| File is already open in a window | Focus that window; return `null` to the sender |
| Sender window has a project | Create a window with that initial project; return `null` |
| Sender window is empty | Claim the file for the sender; return the project |

The renderer's existing `if (!opened) return` handles `null`. `disposeAllTerminals()`
remains in `App.tsx` only for the case where a project was returned, which can only
happen in an empty window.

Paths are compared after `realpath`, so a symlinked path can't open a project twice.

Menu:

- **New Window** (⌘⇧N, new) creates an empty window.
- **New Project** (⌘N) opens a new window at the start screen if the focused window
  has a project; otherwise it behaves as it does today.
- **With no windows open** (macOS), New Project and Open Project first create an
  empty window and send the command to it once it has loaded. Commands that need a
  project (Save, New Terminal Tab, Close Tab, Toggle Global Claude) do nothing.

**Save As** onto a file open in another window is refused with an error dialog,
because the two windows would overwrite each other.

Two different project files may reference the same worktree. Each window runs its
own sessions there.

## Routing main-process events

### Ptys

`hosts/ptyWindows.ts` (new) holds a pty id → `WebContents` map, set in `pty:spawn` from
`event.sender` before spawning and removed with the owner entry. All `pty:*`
events (`data`, `exit`, `detached`, `reset`) in `LocalHost` and `RemoteHost` go
through `sendToPtyWindow(channel, payload)`, which sends to the owning window
only. Events for a pty with no owner, or a destroyed one, are dropped.

`broadcast` remains for `server:status`, which every window needs.

### MCP

There is still one server. Each window gets its own random token and its own
`0600` config file, `mcp-<webContentsId>.json`, in user data. This replaces the
single `global-claude-mcp.json`.

- `mcp:configPath` returns the file for `event.sender`.
- `authorized` looks up the bearer token (still compared in constant time), which
  identifies the window. `callRenderer` sends to that window.
- `pending` entries record their window. When a window closes, its entries resolve
  immediately with an error, its token is revoked and its file is deleted.
- Files left by a crash are removed when the server starts.

### Unchanged

- `docker:log` and `env:log` already reply to `event.sender`.
- `stacks.ts` is request/response with state on disk, and its `stopping` set is keyed
  by worktree, so it's correct across windows.
- Remote server connections are shared across windows and last until the final
  window closes. Removing a server in one window also ends that server's sessions in
  any other window using the same server id.
- `localStorage` is shared, which affects only the Global Claude panel height.

## Close and quit

**Close handshake.** The window's `close` event is intercepted and main sends
`window:close-request`. The renderer then:

1. Saves, including the session snapshot, if the project is dirty or has live
   sessions and has a file.
2. If the project has never been saved and is dirty or has live sessions, prompts
   Save / Don't Save / Cancel.
3. If a save fails, prompts Close Anyway / Cancel with the error.
4. Replies `window:close-ready` or `window:close-cancelled`.

An empty window, or a clean project with no live sessions, replies at once without
writing.

If there's no reply within 5 seconds, main shows Force Close / Keep Waiting. The
timer pauses while one of main's close or save dialogs is open.

**On close-ready**, main disposes the window's local ptys, detaches its remote ptys
(which keep running on their daemons), clears its registry and MCP state, and
destroys the window.

**Quit.** `before-quit` is intercepted, the window list is frozen and each window
runs the handshake in turn. Cancel stops the quit, and windows that already closed
stay closed. The existing `disposeAllPtys` and `disconnectAllServers` calls run once
every window has closed.

`window-all-closed` keeps its current behaviour: it cleans up, and quits except on
macOS.

## Restoring windows

`open-windows.json` in user data holds `{ filePath, bounds }[]`. Its validation
logic, and `decideOpen`, are pure functions in `src/main/windowRules.ts`.

- Written with a 500 ms debounce when a window's project or bounds change.
- Only windows with a saved project are recorded.
- Closing a window removes its entry. During a quit, entries are kept, so the file
  describes the windows open at quit. A crash leaves the last written state, so it
  restores too.
- If a quit is cancelled, the windows already closed are removed from the file.

On launch, entries open one at a time. Missing files are dropped. Bounds that don't intersect
a current display fall back to defaults. If nothing can be restored, one empty
window opens. Sessions stay unloaded, as on any project open.

The macOS `activate` handler creates an empty window and doesn't restore.

## Testing

**Unit (`node --test`):** `decideOpen`, and the restore file's merge, validation and
off-screen bounds logic.

**`npm run smoke:windows` (new, following `multi-repo-smoke.mjs`):** opens two
projects and checks that

- pty output reaches only the owning window
- an MCP call using each window's config acts on that window's project
- opening an already-open project focuses its window without adding one
- closing one window leaves the other's sessions running and ends the closed
  window's ptys
- quitting and relaunching restores both windows

`npm run typecheck`, `npm test` and the existing smoke scripts must still pass.

## Out of scope

- Moving a project or session between windows.
- An "open in this window" option.
- Restoring running sessions automatically on launch.
- Restoring never-saved projects.
