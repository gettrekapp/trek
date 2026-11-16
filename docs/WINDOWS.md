# Trek on Windows: the desktop app and trek-server

The Trek desktop app and trek-server run on Windows 10 (1809 or later) and Windows 11, x64.
trek-server serves the Trek desktop app on any platform, the web client and the phone. Environments
and dev stacks are not available on Windows yet, on the desktop app's Local server or on a Windows
trek-server: the server's welcome leaves the `env` and `stacks` capabilities out, so clients hide
them. The project bot does not run on Windows.

The first part below is the desktop app; the second is trek-server.

# Trek desktop on Windows

## Install

Download `Trek-<version>-win-x64.exe` from the
[latest release](https://github.com/gettrekapp/trek/releases/latest) and run it. It is a one-click
NSIS installer that installs for your user only: no administrator rights and no UAC prompt. Trek
goes to `%LOCALAPPDATA%\Programs\Trek`, with Start-menu and desktop shortcuts, and `.trekproj`
files open in Trek.

The installer is not code-signed yet. Windows SmartScreen shows "Windows protected your PC" with an
unknown publisher: choose **More info** → **Run anyway**. Updates still install: electron-updater
checks an update's signer only when the installed build carries a `publisherName` in its
`resources/app-update.yml`, and only a signed build does (when signing is switched on, see
docs/RELEASING.md). An unsigned build has none, so the updater verifies nothing beyond the SHA-512
in `latest.yml`, which comes from the same GitHub release.

The agent CLIs you use (`claude`, `codex`, `gemini`, `grok`) and Git for Windows must be installed
and signed in as your user, as for trek-server below.

## Where things live

- `%APPDATA%\Trek Dev`: Trek's user data (windows, settings, saved tokens). The app's name is
  "Trek Dev".
- `%APPDATA%\trek-server\local`: the Local server's profile.
- `%LOCALAPPDATA%\Programs\Trek`: the app itself.

## The Local server

The Local server runs on `Trek.exe` in Node mode, with no console window. It keeps running after
Trek quits, so your sessions survive. Turn on "Stop local server on quit" to stop it with the app.
A second launch of Trek focuses the running one.

Open in VS Code works: Trek finds `code.cmd` and runs VS Code's `Code.exe` directly.

## Updating

Trek checks for a newer release as on the Mac: "Update available", then **Download**, then
**Restart to Update**. **File → Check for Updates…** checks on demand. Before it installs, Trek
stops the Local server, because the installer must replace `Trek.exe`. Its terminals close, and
agent sessions resume when you open their worktrees again. If the server can't be stopped, the
update isn't installed and Trek says so. An update installs only through Restart to Update, never
when Trek quits.

## Reinstalling and uninstalling

Running the installer over an installed Trek, and uninstalling, find every process running from the
install folder, the Local server included. Interactively they ask, then close them; run silently
(`/S`) they close them without asking. That is a hard stop: the Local server's sessions end and
resume when their worktrees are opened again.

Uninstall from Settings → Apps. `%APPDATA%\Trek Dev` stays, so reinstalling finds your projects and
settings.

## Not on Windows yet

Environments and dev stacks (planned) and the project bot. A remote trek-server on macOS or Linux
has environments and stacks.

## Manual checklist for the desktop app (before the first Windows release)

Run on a real Windows PC (x64), with the draft release's `Trek-<version>-win-x64.exe`.

1. Install it from the draft and start it. No console window appears for the Local server. The
   SmartScreen's More info → Run anyway starts the installer.
2. A Claude session's terminal works (ConPTY).
3. Quit Trek: the Local server keeps running. Start Trek again: it reconnects.
4. Launch Trek a second time: the running Trek comes forward.
5. Double-click a `.trekproj` file: Trek imports it.
6. A session that needs a decision raises a toast notification.
7. Open in VS Code opens the worktree.
8. Install the previous Windows release, then update to this one with Restart to Update. The Local
   server stops, Trek restarts on the new version, and opening a worktree resumes its sessions.
9. Run this release's installer over itself with Trek and the Local server running. It asks, then
   closes them.
10. Uninstall from Settings → Apps. The app is gone and `%APPDATA%\Trek Dev` remains.

Report anything that differs.

# trek-server on Windows

trek-server runs on Windows as a server that the Trek desktop app on any platform, the web client
and the phone connect to.

## What it needs

- Node.js 22 or later on PATH (or `TREK_NODE` set to a `node.exe`).
- Git for Windows (`git` on PATH). Trek turns on `core.longpaths` for its own git commands.
- The agent CLIs you use, installed and signed in as the user the server runs as: Claude Code
  (the native installer's `claude.exe`, or `npm install -g @anthropic-ai/claude-code`), Codex
  (`npm install -g @openai/codex`), Gemini, Grok.

## How it differs from macOS and Linux

- **Where things live.** The config (tokens, repositories, keys) is in `%APPDATA%\trek-server`;
  the projects and MCP files are in `%LOCALAPPDATA%\trek-server`. File modes such as 0600 do not
  exist on Windows: these files are protected by your user profile's permissions.
- **How agents start.** There is no login shell. Trek finds the agent's program on PATH (with
  PATHEXT, never in the repository's own folder) and starts it directly. An agent installed with
  npm (a `.cmd` shim) is started as `node <its script>`, so multi-line prompts work. Any other
  batch file is run by `cmd.exe`, which cannot pass an argument containing a line break, so such
  a session is refused with a message. A custom command can't start with `NAME=value`: set the
  variable in the server's environment instead. An agent shows as installed only when its
  command is a bare name found on PATH or a full path (`C:\…`), to a program Trek can start; a
  relative path (`.\tools\claude.exe`) is found from the worktree when a session starts, so it
  shows as not installed but still starts.
- **Repositories** must be on a local drive (`C:\…`). Network shares and WSL paths
  (`\\wsl$\…`, `\\wsl.localhost\…`) are refused: to work on a repository inside WSL, run the
  Linux trek-server inside WSL and connect to it as a remote server.
- **Linked directories** (a repository's linkedDirs) are junctions, which need no admin rights.
  A linked *file* becomes a symlink only with Developer Mode on; otherwise it is copied, and the
  worktree's creation says so.
- **Worktree folders** drop the characters Windows forbids in names (`<>:"|?*`), trailing dots
  and spaces, and get a `-` after a device name (`CON`, `NUL`, `COM1`…). The branch keeps its name.
- **Launchers.** The zip has `bin\trek-server.cmd` (what `trek-server` resolves to on PATH) and
  `bin\trek-server.ps1`. With the `.cmd`, cmd.exe may ask "Terminate batch job (Y/N)?" on Ctrl+C
  (answer Y); the PowerShell one does not. The release zip's `.ps1` is not signed (yet), so Windows may refuse it
  under the default execution policy, as for any unsigned build (one from source, or the artifact of
  ci.yml's Windows job): run
  `powershell -NoProfile -ExecutionPolicy Bypass -File bin\trek-server.ps1 start`, or
  `Get-ChildItem -Recurse <folder> | Unblock-File` once after unzipping.
  Both run the `node` found on PATH, and cmd.exe looks in the current directory before PATH: a
  `node.exe` (or `node.cmd`) in the folder you start `bin\trek-server.cmd` from would run instead.
  Start it from a directory you trust (not a repository's), or set `TREK_NODE` to the absolute
  path of `node.exe`.
- **Stopping.** Ctrl+C (or Ctrl+Break, or closing the console) shuts the server down cleanly.
  `trek-server stop --local` asks the local server to stop over its own connection
  (`server.stop`); a stop from another process by signal is not possible on Windows.
- **Terminals** are ConPTY. Clients set xterm.js up for it from the server's `pty.attach` answer.
- **Updating.** `trek-server update` is not available on Windows yet (it says so and exits 1):
  stop the server, unzip the new release beside the old one and start that. The config and the
  projects are not in the folder, so they carry over.

## Manual checklist for trek-server (before a release)

Run on a real Windows PC (x64), with the release's `trek-server-<version>-win32-x64.zip`. Use a
throwaway repository.

1. Install Node.js 22, Git for Windows, Claude Code (first with npm, later the native
   installer: do steps 4 and 5 with each) and Codex (npm).
2. Unzip the release (Explorer's Extract All, so the files carry the download mark as a user's
   would). In PowerShell: `.\trek-server-<version>-win32-x64\bin\trek-server --version` prints
   the version.
3. `trek-server add C:\src\scratch`, `trek-server token`, then `trek-server start --host 0.0.0.0
   --insecure` on a private network, or behind a TLS proxy (see server/README.md).
4. From the Mac's Trek: add the server with the token; create a project from the repository; add
   a worktree for a branch with a `/` and a long name (over 100 characters of path).
5. Start a Claude session and a Codex session from a session type whose prompt has several lines
   and an initial message with `"quotes"`, `100%` and `&`. Both agents start, receive the whole
   prompt, and the trek-dev MCP tools work (ask each to call `get_current_session` and
   `list_worktrees`).
6. Unload the worktree and load it again: each session resumes. Close one session.
7. Give the repository a linkedDirs entry `.trek` (with a file in the main checkout's
    `.trek`), add a worktree (its `.trek` is a junction), then remove the worktree, once with
    uncommitted changes (forced) and once clean. Each time the main checkout's `.trek` and its
    file are still there.
8. Promote the worktree to primary, then demote it back, with an uncommitted change carried.
9. With `git config --global core.autocrlf true` on Windows, move a worktree with uncommitted
   changes from the Mac to the Windows server and back; the files arrive with the right line
   endings and the move reports no mismatch.
10. Watch the desktop while the server polls git for a minute: no console window flashes.
11. Connect the phone (pair from the Mac's Trek) and the web client (`start --web`): both show the
    Windows server's terminals, wrapped correctly at their width.
12. Stop the server with Ctrl+C in its console; start it again: the projects are all there.
13. In another profile, `trek-server start --local --local-profile check`, then from another
    console `trek-server stop --local --local-profile check`: it prints "Stopped.", and
    `%APPDATA%\trek-server\local-check\local.json` and `local.lock` are gone.

Report anything that differs, with the server's console output.
