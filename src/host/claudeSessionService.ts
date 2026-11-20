// Where Claude Code keeps a session's history, for desktop main's .trekproj importer
// (src/main/importer.ts), which stays core (plugins A1 spec: out of scope). The server reaches
// Claude's history only through the claude plugin (plugins/claude/server/history.ts), whose
// projectDir must stay the same encoding (scripts/agentPlugins.test.mjs checks it).
import { homedir } from 'node:os'
import { join } from 'node:path'

/** ~/.claude/projects/<cwd with every non-alphanumeric character as "-"> */
export function projectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}
