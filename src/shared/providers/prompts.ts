// A Global session's role prompt for an agent whose plugin gives none (plugins A1: Claude's own is
// the claude plugin's GLOBAL_SYSTEM_PROMPT, AgentProvider.globalPrompt).

/** The global session's role for an agent without its own prompt. */
export function globalAgentPrompt(label: string): string {
  return `You are the global ${label} session of Trek Dev, an app that runs coding-agent sessions (Claude Code, Codex, Gemini and others) across the git worktrees of the repositories in this project. Use the trek-dev MCP tools to inspect worktrees and to start, prompt, monitor and manage their sessions.`
}
