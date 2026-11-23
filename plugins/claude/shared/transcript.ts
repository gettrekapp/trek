// Claude Code's session transcript (campsite part 4): one JSON object per line. An `assistant` line's
// `message.content` holds the model's blocks; each `tool_use` block is a tool call (its `name` and
// `input`). This reads the tool calls out of a line as Trek's AgentTool: a kind from the tool's name
// and a short label from its input. Pure: the server half follows the file (server/activity.ts).
import { toolLabel, type AgentTool, type AgentToolKind } from '../../../src/shared/plugins/agents.ts'

/** Claude Code's own tools by kind; an `mcp__<server>__<tool>` name is an MCP tool; any other is `other` */
const KINDS: Readonly<Record<string, AgentToolKind>> = {
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  LS: 'read',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  Task: 'delegate',
  Agent: 'delegate',
  WebFetch: 'web',
  WebSearch: 'web'
}

export function toolKind(name: string): AgentToolKind {
  if (name.startsWith('mcp__')) return 'mcp'
  return Object.hasOwn(KINDS, name) ? KINDS[name] : 'other'
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A non-blank string field of the input */
const text = (input: Record<string, unknown>, key: string): string | undefined => {
  const v = input[key]
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}
/** A path's last part (either slash; a trailing one dropped) */
const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
/** A URL's host, or '' when it is not a URL */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * A tool call's label: an MCP tool's "server tool"; else a file's base name (file_path,
 * notebook_path), a search's pattern (pattern, query), a folder's base name (path), a command's
 * first line (command), a URL's host (url), a subagent's description; else, for a tool of kind
 * other, its name. Cut to 40 characters.
 */
export function toolLabelOf(name: string, input: Record<string, unknown>): string {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length)
    const cut = rest.indexOf('__')
    return toolLabel(cut < 0 ? rest : `${rest.slice(0, cut)} ${rest.slice(cut + 2)}`)
  }
  const file = text(input, 'file_path') ?? text(input, 'notebook_path')
  if (file) return toolLabel(baseName(file))
  const search = text(input, 'pattern') ?? text(input, 'query')
  if (search) return toolLabel(search)
  const folder = text(input, 'path')
  if (folder) return toolLabel(baseName(folder))
  const command = text(input, 'command')
  if (command) return toolLabel(command.trim().split('\n')[0])
  const url = text(input, 'url')
  if (url) return toolLabel(hostOf(url))
  const description = text(input, 'description')
  if (description) return toolLabel(description)
  return toolKind(name) === 'other' ? toolLabel(name) : ''
}

/** The tool calls on one transcript line, in order: none for a line that is not an assistant's, or not JSON */
export function toolsInLine(line: string): AgentTool[] {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return []
  }
  if (!isRecord(value) || value.type !== 'assistant' || !isRecord(value.message) || !Array.isArray(value.message.content)) return []
  const out: AgentTool[] = []
  for (const block of value.message.content) {
    if (!isRecord(block) || block.type !== 'tool_use' || typeof block.name !== 'string' || block.name === '') continue
    out.push({ kind: toolKind(block.name), label: toolLabelOf(block.name, isRecord(block.input) ? block.input : {}) })
  }
  return out
}
