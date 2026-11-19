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
and a move carries a Claude session's history file to the other server.

Tests and smokes never run the real CLI: `scripts/fixtures/fake-claude.mjs` and the fake agents of
`scripts/fakeAgent.mjs` stand in, through the server config's `command`.
