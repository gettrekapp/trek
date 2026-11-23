# The claude plugin

Claude Code in Trek's agent sessions (plugins A1; core before). It offers two agents:

- `claude`: the `claude` CLI with its permission mode, model, effort, Trek's MCP tools
  (`<mcp dir>/<projectId>.json`), the session's system prompt and a preset session id. A Global
  session gets Claude's own role prompt.
- `local`: the same CLI against a local model's Anthropic-compatible endpoint (Ollama or LM Studio),
  from the server config's `llm.providers.local` (`backend`, `baseUrl`, `command`, `approvalMode`).

It owns three project settings, stored under the names core used before: `claudeCommand`,
`claudeArgs` (they replace `--permission-mode`) and `claudePermissionMode`. Claude is the fallback
agent: an unknown agent id runs Claude. Claude's history (`~/.claude/projects`) follows a promote,
and a move carries a Claude session's history file to the other server. Claude reports its
sessions' tool calls (campsite part 4: the agent's `activity`): `server/activity.ts` follows a
running session's transcript (`~/.claude/projects/<cwd>/<id>.jsonl`, from its end, or from its top
when it appears later), and `shared/transcript.ts` reads each assistant line's `tool_use` blocks
(lines without `"tool_use"` aren't parsed) as a kind (read, edit, run, delegate, web, mcp, other)
and a short label. Local reports none. Where the transcript is isn't certain, so
`transcriptFiles` gives up to four paths, polled (a stat each every 2 s) until one exists, which
is then followed alone: the cwd with its symlinks resolved (as Claude names the folder on POSIX),
then the cwd as given (Claude on Windows keeps a junction unresolved), each under
`$CLAUDE_CONFIG_DIR/projects` when it is set, then under `~/.claude/projects`.
`CLAUDE_CONFIG_DIR` is read from the server's env, not your shell's: set only in a shell profile,
with Trek started from the Dock (or the server from a service), a custom config dir is missed
unless it is `~/.claude`, and those hikers do the random chores. A file busy for a moment (EBUSY,
or EPERM on Windows) is tried again for up to 30 polls; any other error on the followed file ends
the follow, logged once. While searching, a path that can't be read (EACCES, say) is skipped; its
error counts only when none of the paths is there. When the followed file goes, another path
already there is followed from its end (its history isn't replayed); one that appears later, from
its top.
A `/clear` starts a new transcript that isn't followed: its hiker thinks for two minutes after the
last call it saw, then goes back to the random chores. Newer Claude versions may shorten a very
long cwd's folder name with a hash (unverified); such a session's transcript isn't found, and its
hiker does the random chores.

Tests and smokes never run the real CLI: `scripts/fixtures/fake-claude.mjs` and the fake agents of
`scripts/fakeAgent.mjs` stand in, through the server config's `command`.

Its client half (plugins A2) lists it in Settings → Plugins, always on, with the project's Claude
session mode and a Test of the Local agent's endpoint: the server lists the models it finds at the
`llm.providers.local` URL in its config (backend `ollama` or `lmstudio`, `baseUrl`), which is edited
by hand there.
