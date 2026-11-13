import { launchSpec, quoted, shellQuote, word } from './shell.ts'
import type { LaunchArg, LaunchOptions, LaunchSpec, LlmProvider } from './types'

const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high']

/** `-c key=value` override; the value is TOML, and a JSON string is a valid TOML basic string. */
function config(key: string, value: string): LaunchArg[] {
  const safe = value.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')
  const toml = JSON.stringify(safe).replace(/\x7f/g, '\\u007f')
  return [word('-c'), quoted(`${key}=${toml}`)]
}

function approvalFlags(mode: string | undefined): LaunchArg[] {
  switch (mode) {
    case 'on-request':
      return [word('-a'), word('on-request')]
    case 'untrusted':
      return [word('-a'), word('untrusted')]
    case 'yolo':
      return [word('--dangerously-bypass-approvals-and-sandbox')]
    default:
      return [word('--full-auto')]
  }
}

export const codex: LlmProvider = {
  id: 'codex',
  label: 'Codex',
  glyph: 'CX',
  defaultCommand: 'codex',
  capabilities: {
    presetSessionId: false,
    resume: true,
    mcp: true,
    appendSystemPrompt: true,
    effort: true,
    addDirs: true,
    sessionMigration: false
  },
  models: [
    { id: 'gpt-5-codex', label: 'GPT-5 Codex', efforts: CODEX_EFFORTS },
    { id: 'gpt-5', label: 'GPT-5', efforts: CODEX_EFFORTS }
  ],
  efforts: CODEX_EFFORTS,
  approvalModes: [
    { value: 'full-auto', label: 'Full auto (sandboxed)' },
    { value: 'on-request', label: 'Ask on request' },
    { value: 'untrusted', label: 'Ask for untrusted commands' },
    { value: 'yolo', label: 'No sandbox, no approvals' }
  ],
  defaultApprovalMode: 'full-auto',
  statusMarkers: ['esc to interrupt'],
  buildLaunch(o: LaunchOptions): LaunchSpec {
    const args: LaunchArg[] = []
    if (o.resume) args.push(word('resume'), quoted(o.sessionId))
    args.push(...approvalFlags(o.approvalMode?.trim()))
    // Attached, so a value starting with a dash can never be read as a flag.
    if (o.model) args.push(quoted(o.model, '--model='))
    if (o.effort) args.push(...config('model_reasoning_effort', o.effort))
    // The token comes from a helper command (Codex 0.148+), never the environment: any process of
    // this user, the bot's included, can read another's environment (`ps -E`, KERN_PROCARGS2).
    if (o.mcp) {
      args.push(
        ...config('mcp_servers.trek-dev.url', o.mcp.url),
        ...config('mcp_servers.trek-dev.http_headers_helper', o.mcp.codexHeadersHelper)
      )
    }
    if (o.systemPrompt) args.push(...config('developer_instructions', o.systemPrompt))
    for (const dir of o.addDirs ?? []) args.push(word('--add-dir'), quoted(dir))
    if (!o.resume && o.initialMessage) args.push(word('--'), quoted(o.initialMessage))
    return launchSpec(o.command?.trim() || 'codex', args)
  }
}

/**
 * The `http_headers_helper` command for a headers file (`{"Authorization": "Bearer …"}`, mode 0600).
 * Codex runs it with `sh -c` (`cmd /C` on Windows) and a cleared environment, so the path is absolute.
 */
export function codexHeadersHelper(headersPath: string, platform: string): string {
  return platform === 'win32' ? `type "${headersPath}"` : `/bin/cat ${shellQuote(headersPath)}`
}

export interface CodexSessionMeta {
  id: string
  cwd: string
  startedAt: number
}

/** The session_meta record on the first line of a ~/.codex/sessions rollout file. */
export function parseCodexSessionMeta(firstLine: string): CodexSessionMeta | undefined {
  let record: Record<string, unknown>
  try {
    record = JSON.parse(firstLine)
  } catch {
    return undefined
  }
  if (record?.type !== 'session_meta') return undefined
  const payload = (record.payload ?? {}) as Record<string, unknown>
  const id = payload.id
  const cwd = payload.cwd
  const stamp = Date.parse(String(payload.timestamp ?? record.timestamp ?? ''))
  if (typeof id !== 'string' || typeof cwd !== 'string' || Number.isNaN(stamp)) return undefined
  return { id, cwd, startedAt: stamp }
}
