import type { BotEventKind } from '../../shared/bot'

export interface ParsedLine {
  events: { kind: BotEventKind; text: string }[]
  sessionId?: string
  result?: { isError: boolean; text: string; apiStatus: number | null }
  limited: boolean
}

export type FailureKind = 'auth' | 'limit' | 'resume' | 'crash'

const MAX_TOOL_TEXT = 200

function toolText(name: string, input: unknown): string {
  const text = `${name} ${JSON.stringify(input ?? {})}`
  return text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}…` : text
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseStreamLine(line: string): ParsedLine {
  const parsed: ParsedLine = { events: [], limited: false }
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return parsed
  }
  if (!isRecord(json)) return parsed
  if (json.type === 'system' && json.subtype === 'init') {
    if (typeof json.session_id === 'string') parsed.sessionId = json.session_id
  } else if (json.type === 'assistant') {
    const content = json.message?.content
    for (const block of Array.isArray(content) ? content : []) {
      if (!isRecord(block)) continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        parsed.events.push({ kind: 'text', text: block.text })
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        parsed.events.push({ kind: 'tool', text: toolText(block.name, block.input) })
      }
    }
  } else if (json.type === 'rate_limit_event') {
    parsed.limited = json.rate_limit_info?.status === 'rejected'
  } else if (json.type === 'result') {
    const errors = Array.isArray(json.errors)
      ? json.errors.filter((e: unknown): e is string => typeof e === 'string').join('\n')
      : ''
    parsed.result = {
      isError: !!json.is_error,
      text: typeof json.result === 'string' ? json.result : errors,
      apiStatus: typeof json.api_error_status === 'number' ? json.api_error_status : null
    }
  }
  return parsed
}

const AUTH_LINE =
  /^(not logged in|invalid api key|invalid auth token|authentication required|login expired|oauth token revoked|failed to authenticate)/i
const LIMIT_LINE =
  /^(you['’]ve hit your (.* )?(limit|budget)|you['’]ve reached your (.* )?limit|you['’]re out of usage credits)|usage limit reached/i

export function classifyFailure(text: string, apiStatus: number | null = null): FailureKind {
  if (apiStatus === 401) return 'auth'
  if (apiStatus === 429) return 'limit'
  if (/no conversation found/i.test(text)) return 'resume'
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  if (lines.some((l) => AUTH_LINE.test(l))) return 'auth'
  if (lines.some((l) => LIMIT_LINE.test(l))) return 'limit'
  return 'crash'
}
