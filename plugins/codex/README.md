# The codex plugin

OpenAI's Codex CLI in Trek's agent sessions (plugins A1; core before). Its approval mode and command
come from the server config's `llm.providers.codex`. Trek's MCP tools reach it through `-c` overrides
and a headers helper that prints the token from `<mcp dir>/<projectId>.codex.json` (0600): the token
is in neither its argv nor its environment. Codex picks its own session ids; Trek finds each one in
`$CODEX_HOME/sessions` (default `~/.codex/sessions`) after the launch, for resume.

Tests never run the real CLI: the smokes' fake agents stand in, and discovery is tested on a temp
sessions folder.
