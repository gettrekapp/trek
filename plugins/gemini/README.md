# The gemini plugin

Google's Gemini CLI in Trek's agent sessions (plugins A1; core before). It takes a preset session
id, its approval mode from the server config's `llm.providers.gemini`, and Trek's MCP tools from a
system settings file (`<mcp dir>/<projectId>.gemini.json`, through `GEMINI_CLI_SYSTEM_SETTINGS_PATH`).
It has no flag for a system prompt: the prompt rides ahead of the first message.
