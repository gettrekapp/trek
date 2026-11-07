// The userData files a bot may never read or write (see host/bot/policy). Pure.
//
// Policy also denies each one's temp and set-aside copies (`<name>.<pid>.tmp`, `<name>.corrupt-<time>`),
// and `*` stands for any run of characters in a name, for the per-window MCP configs.
export const BOT_SECRET_FILES = [
  // Encrypted secret stores (createSecretStore)
  'elevenlabs.json',
  'linear.json',
  'server-tokens.json',
  'app-server-tokens.json',
  // Which v2 servers this machine trusts with its tokens: a bot that rewrote it could redirect them.
  'app-servers.json',
  // A bot that could write the consent list could approve other bots.
  'bot-consent.json',
  // Docker environments: each one's env vars (database passwords, API keys) for compose. The bot
  // runs environments through Trek's tools, never this file.
  'environments.json',
  // MCP configs: each holds a bearer token for the app's MCP server (mcp-<id>, mcp-bot-<id>, mcp-gemini-<id>,
  // and mcp-codex-<id>, the headers Codex's helper prints).
  'mcp-*.json',
  'global-claude-mcp.json'
]
