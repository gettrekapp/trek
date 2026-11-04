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
- **Recent projects**: the start screen lists the last 8 project files you opened
  or saved (stored in the app's user-data directory; missing files are dropped).

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
