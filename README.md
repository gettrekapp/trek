# Trek Dev

An Electron + React + TypeScript app for running Claude Code, or Codex, Gemini, Grok and
local models, across multiple git worktrees of a repository, side by side.

<img width="1206" height="765" alt="Screenshot 2026-07-22 at 2 48 07 PM" src="https://github.com/user-attachments/assets/16ea55ed-6a88-4f7d-bc72-9ee9fa21fce9" />

## Concepts

- **Project file** (`.trekproj`, JSON): lists one or more repositories and remembers
  which worktrees have Claude sessions, tickets and PRs linked. Tags, notes, tickets,
  PR links and env vars are kept per repository, so a branch name shared by two
  repositories has independent data. Older files upgrade when opened; once saved, they
  can't be read by older Trek builds. `File → Save Project` (⌘S).
- **Repositories**: each one is a collapsible sidebar section, and a collapsed section
  still shows its session status. **Add repository…** in the sidebar footer adds one,
  and the section's **⋯** menu removes it from the project without touching the disk.
  A repository can't be removed while it has live sessions, and the first one can't be
  removed while Global Claude has saved conversations.
- **Worktree sidebar**: lists *every* git worktree of each repository (polled live),
  with the Claude session status dot, branch, workflow tag, ticket/PR chips and
  git ahead/behind/dirty state. The poll is two-tier: the worktree list is one
  git process per host and refreshes every 5s, while dirty/ahead/behind costs
  two git processes *per worktree* — across a repo with many worktrees that is
  seconds of CPU per sweep, so it refreshes every 30s, only while the window
  has focus, plus immediately when the list changes, the window regains focus,
  the selection moves, or a pull/push finishes. The `+` on a repository's section adds an existing worktree or creates a
  new one (`git worktree add`) — new worktrees are created next to the repository
  as `<repo>-<branch>`. The main checkout is tagged **PRIMARY**.
- **Workflow tags**: each branch can carry a tag (In Progress, In Review,
  Changes Needed, Waiting for SQL, In Testing, Ready for Dev, Ready to Deploy,
  Remove) — click the tag chip in the detail pane to change it, and filter the
  sidebar by tag with the "Tag:" dropdown under the worktree list. New worktrees start as
  **In Progress**. Tags are keyed to the branch and saved in the project file,
  so they survive the worktree being promoted to primary, deleted and re-created.
- **Detail pane**: the selected worktree's branch, path and linked ticket/PR,
  with quick actions (Open in VS Code, Reveal in Finder) and an overflow menu
  (link ticket/PR, promote to primary, delete worktree). Ticket and PR links are
  keyed to the branch — like tags and notes — so they survive promoting to
  primary and back, or deleting and re-creating the worktree. A ticket is a
  Linear issue (`TOW-123`, or paste its `linear.app/<workspace>/issue/…` URL —
  the workspace is remembered per project) or a legacy Azure DevOps work item
  id; when the branch name contains a Linear id (Linear's default
  `user/tow-123-title` format) the ticket dialog pre-fills it. Add a Linear
  API key in ⚙ Settings to show each issue's status and title on its chip
  (refreshed every 5 minutes and on window focus); the key is stored
  encrypted in the app's user-data directory, never in the project file. The **All Notes**
  panel collects every branch note in one place — including branches whose
  worktree is gone — with a per-note delete. The Notes, Docker and
  ⚙ settings panels live on the right of the session tab row.
- **Claude sessions** (per worktree): each session tab is a real PTY running your
  shell with `claude` auto-launched in the worktree directory. ⌘T (or the `+`
  next to the tabs) opens a new one, click the active tab's title to rename it
  (persisted in the project file), and exited terminals show a **Restart Claude**
  button (which resumes the same session). Worktrees without a session stay
  dormant until you press **Start Claude session** — or, when they have saved
  sessions, until you load them (see below).
- **Loading / unloading worktrees**: each Claude session costs a shell, a
  `claude` process and a terminal instance, so a project opens with *every*
  worktree unloaded — nothing spawns until you ask for it. A worktree with
  saved sessions shows a hollow dot and a **▸N** button in its sidebar row
  (and a **Load sessions** button in its detail pane); loading resumes each
  session one at a time. **⏏** in the row or the session-row **⏏ Unload**
  button gives the sessions back: they are snapshotted into the project file
  and torn down, and **Unload all** in the sidebar footer does the whole
  project at once. Unloading is not closing — the sessions resume where they
  left off. A local `claude` is killed and resumed via `--resume`; a remote one
  keeps running on its server and is reattached on the next load.
- **Session persistence**: every terminal is bound to a Claude session UUID
  (`--session-id` on first launch). Saving the project (⌘S) snapshots the open
  terminals per worktree, so loading a worktree later resumes each one with
  `--resume <uuid>`, picking the conversations back up. Claude starts in
  auto mode by default — change the default session mode in the ⚙ Settings
  panel, or override the flags entirely with a `claudeArgs` field in the
  `.trekproj` file (and `claudeCommand` to replace the binary).
- **Agents**: each session runs one agent CLI: **Claude** (`claude`), **Codex**
  (`codex`), **Gemini** (`gemini`), **Grok** (`grok`) or **Local** (Claude Code pointed
  at Ollama or LM Studio through `ANTHROPIC_BASE_URL`; it needs a model, since Claude's
  default alias means nothing to Ollama). ⚙ Settings → Agents sets the app-wide default
  agent, model and effort for ⌘T and `+`, each agent's command and approval mode, and the
  Local endpoint. A project can override the default (`llmDefault` in the `.trekproj`)
  and pick the Global panel's agent (`globalLlm`, MCP-capable agents only). Session types
  can name their own agent, and `▾ → Choose…` next to `+` picks one for a single session.
  The `start_session` MCP tool takes `provider`, `model` and `effort`, and
  `save_session_type` takes an `llm` object (`{ provider, model?, effort? }`).
  A session always resumes with the agent it started with. Codex picks its own session
  ids, so Trek finds each one in `~/.codex/sessions` (or `$CODEX_HOME/sessions`) after
  launch; a Codex tab that exits before its id is found can't be resumed. Gemini gets the trek-dev MCP server through
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH` and has no system-prompt flag, so a session type's
  prompt is sent ahead of its first message. Grok does the same, and since it can't
  resume, it starts a fresh conversation (carrying that prompt again) on every load.
  A Local session on a remote worktree talks to the server's own localhost, while the
  picker's model list comes from this machine's endpoint. Only Claude and Local sessions follow a worktree when it is promoted, demoted or
  moved; the others are closed with a notice. A first message is passed so that it can't
  be read as a flag, and an effort is only passed if it is one the model accepts.
  Older Trek builds open Codex and Gemini sessions as Claude ones, so don't go back to
  one with such sessions saved.
- **Global panel** (⌘J, or click the status bar at the bottom of the window):
  a project-wide agent session (Claude unless the project picks another) in a
  collapsible panel, running in the
  first repository's root, with the others available as extra directories
  (a repository added mid-session is available from that session's next launch). It starts the first time you open it, keeps running while
  collapsed, and resumes its conversation when the project is reopened
  (**New conversation** starts over). Its status bar shows the same
  working/attention/done badge as any session.
- **MCP server**: the app serves an MCP server (`trek-dev`, Streamable HTTP on
  `127.0.0.1` with a per-launch bearer token, `src/main/mcp.ts`) that the
  global session is launched with. Its tools let it list worktrees, start, load
  and unload sessions, send prompts and keystrokes, read terminal output, wait
  for sessions to finish, see and edit a session's prompt queue, focus or
  close a session, and set a branch's tag,
  note or linked ticket. Tool calls are executed by the renderer (`src/renderer/src/mcpTools.ts`),
  which owns the terminals and project state.
- **Multiple windows**: each window holds one project, with its own sessions and
  Global Claude. Opening a project uses a new window unless the current one is
  empty, and focuses the project's window if it's already open. `File → New Window`
  (⌘⇧N) opens an empty one. Closing a window saves its project and ends its local
  sessions, which resume on reopen; remote sessions keep running. Codex tabs still
  waiting for their session id are ended, local or remote, since nothing could
  resume them. A never-saved
  project asks first. On launch, the windows open at last quit come back with their
  sessions unloaded (`open-windows.json` in the user-data directory).
- **Recent projects**: the start screen lists the last 8 projects you opened or saved,
  project files and server projects mixed (stored in the app's user-data directory).
  Missing files are dropped; a server project stays until you remove it with its **×**.

## Project bot sandbox

Every project bot turn runs in an OS sandbox (`sandbox-exec` on macOS, `bwrap` on
Linux) that hides Trek's user-data directory from the bot's own processes. Each bot
start first proves the sandbox works by trying to read a canary file. If the read
succeeds, or no sandbox is available, the bot won't run. A bot folder or repository
inside the user-data directory is refused too.

Trek's MCP server enforces the bot's policy on every tool call. These eight tools
run something outside the sandbox, so they always ask for your approval, whatever
`POLICY.json` says: `start_session`, `send_prompt`, `send_keys`, `start_stack`,
`create_worktree`, `load_worktree`, `save_session_type`, `delete_session_type`.

**What it doesn't do yet:** it does not stop a determined, prompt-injected bot from
getting code run outside the sandbox. The main ways:

- **Files that run later.** The bot can write files outside the user-data directory
  that unsandboxed programs run later: git config, fsmonitor and hooks (Trek's own
  `git status` runs them), shell rc files, `~/.claude` settings hooks, the project
  file, `stack.sh`, LaunchAgents.
- **Local services.** It can drive unsandboxed local services (Docker, tmux, D-Bus or
  `systemd-run` on Linux, local dev servers), and Apple Events (`osascript`), gated
  only by macOS's Automation consent. The network isn't restricted.
- **Delegation.** `enqueue_prompt` is free and reaches unsandboxed sessions; approved
  `start_session`, `send_prompt` and `send_keys` run unsandboxed sessions.
- **macOS process info.** The bot can read the environment and arguments of any of
  your non-system processes, including `environments.json` values passed to
  `docker compose`. Trek keeps its own tokens out.

Smaller gaps: disk mounts over a parent of the user-data directory (macOS), the bot's
own per-turn token in its environment, a local trek-server's data folder, earlier
copies (hard links, backups, snapshots), Codex older than 0.148 (no Trek tools),
the probe running only at start, and `bwrap` found through PATH. Windows is
unsupported: the bot doesn't run there. The full list is in
`docs/superpowers/specs/2026-11-02-project-bot-core-design.md`. A write allow-list,
which closes the "files that run later" gap, is the planned follow-up.

## Servers and server projects

Trek can also open projects that live on a [trek-server](server/README.md), which
keeps their worktrees and sessions running on that machine. Server windows are
**read-only for now**: they show a live tree but you can't yet work in them.

- **Server list**: **Connect to server…** on the start screen opens the app-wide
  list of servers. **Add server** takes a name, a `ws://` or `wss://` URL and a token;
  each server then has **Set token**, **Test**, **Edit** and **Remove**, and a dot
  for its connection status. Plain `ws://` to anything but this machine is allowed
  (Tailscale, LAN) but shows an "Unencrypted" warning, the app-side half of the
  server's rule never to expose its plain `ws://` listener beyond loopback (see
  [Security notes](server/README.md#security-notes)). Create tokens on the server
  with `trek-server token add <device>` (see [the server README](server/README.md#projects)).
- **Tokens** are encrypted with the OS keychain (Electron safeStorage) in
  `app-server-tokens.json` in the user-data directory, owner-only. When no OS
  keyring is available (for example on Linux without one) safeStorage can't
  encrypt, and tokens are stored only base64-encoded with a `plain:` prefix, so the
  file's owner-only permissions are then the only protection. They never reach
  the window: main opens the WebSocket, relays it, and puts the token into the
  `hello` itself. Changing a server's URL to another origin (scheme, host or port)
  clears its token, so you enter it again.
- **Projects**: pick a server to list its projects and **Open** one, or
  **New Project…** to create one from a name and the server's registered repos.
  **Add repo by path…** registers another repo there; if the server refuses the
  path (`PATH_DENIED`) or it isn't a git repo (`NOT_A_REPO`), the hint is to run
  `trek-server add <path>` on the server.
- **Server windows**: one per server project, focused if it's already open. It
  lists the repositories, their worktrees (branch, missing, dirty/ahead/behind,
  loaded) and each worktree's sessions, plus Global sessions, updating live. If the
  connection drops, a banner says so and the last tree stays. A project deleted on
  the server, or one it doesn't know when the window opens, shows "Project not
  found" with **Pick another project**; a server
  you removed from the list shows "Server removed". A window stuck on a rejected
  token or an incompatible server tries again when you focus it, so a token set in
  another window takes. Closing the window asks
  nothing, since the sessions keep running on the server. Server windows appear in
  recents and come back on launch like file windows.
- **Still to come**: a working server window with terminals and sessions (phase 3c),
  then attention badges and notifications for server sessions (phase 3d). Until
  then, the per-project servers under ⚙ Settings → Servers remain the way to run
  remote sessions from a project file.

## Attention indicators

Each session tab shows a status badge, and each sidebar row a status dot:

| Badge | Meaning |
| --- | --- |
| spinner | Claude is producing output (working) |
| orange `?` (pulsing tab) | Claude rang the terminal bell — it's waiting on you |
| green `✓` | Output went quiet after activity — Claude is likely done |
| hollow `✓` | Marked fully complete — status tracking paused |
| gray `✕` | The process exited |

Click a green `✓` to mark that terminal **fully complete**: the badge hollows
out and the terminal stops producing status changes and notifications entirely.
Click the hollow `✓` to resume tracking — or just type in the terminal, which
re-engages it automatically.

Focusing/clicking a terminal clears its badge. A sidebar row's dot shows the
highest-priority status of that worktree's sessions (pulsing green = working,
orange = needs you, solid green = done, gray = idle, hollow ring = unloaded
with saved sessions).

You also get native macOS notifications: always when a terminal hits *attention*
while out of view, and on *done* when the app window isn't focused. Clicking a
notification focuses the app and jumps to that worktree + terminal.

> **Tip:** for the most reliable "Claude needs you" signal, enable bell
> notifications in Claude Code: `claude config set --global preferredNotifChannel terminal_bell`.
> The idle-detection fallback works either way.

## Development

```bash
npm install
npm run rebuild   # rebuild node-pty against Electron's Node headers
npm run dev       # launch in dev mode with HMR
npm run build     # production build into out/
npm run typecheck
```

The project file format lives in `src/shared/types.ts` (`ProjectFile`, `Repository`), and
older files are upgraded by `src/shared/migration.ts`. `npm test` runs the unit tests;
`npm run smoke:multi` runs the two-repository end-to-end test, and
`npm run smoke:providers` starts Codex and Gemini sessions against fake CLIs. Terminal
PTYs are managed in the main process (`src/main/pty.ts`); xterm.js instances,
the attention heuristics and worktree load/unload live in the renderer
(`src/renderer/src/terminals.ts`). Which worktrees are loaded is runtime-only
state (`loadedWorktrees` in the store) — it decides, per worktree, whether the
live terminals or the project file's saved session list is the truth on save.
