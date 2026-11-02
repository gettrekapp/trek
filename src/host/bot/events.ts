import type { BotEventKind } from '../../shared/bot'

export interface ParsedLine {
  events: { kind: BotEventKind; text: string }[]
  sessionId?: string
  result?: { isError: boolean; text: string }
  limited: boolean
}

export type FailureKind = 'auth' | 'limit' | 'resume' | 'crash'

const MAX_TOOL_TEXT = 200

function toolText(name: string, input: unknown): string {
  const text = `${name} ${JSON.stringify(input ?? {})}`
  return text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}…` : text
}

export function parseStreamLine(line: string): ParsedLine {
  const parsed: ParsedLine = { events: [], limited: false }
  let json: Record<string, any>
  try {
    json = JSON.parse(line)
  } catch {
    return parsed
  }
  if (json.type === 'system' && json.subtype === 'init') {
    parsed.sessionId = json.session_id
  } else if (json.type === 'assistant') {
    for (const block of json.message?.content ?? []) {
      if (block.type === 'text' && block.text) parsed.events.push({ kind: 'text', text: block.text })
      if (block.type === 'tool_use') parsed.events.push({ kind: 'tool', text: toolText(block.name, block.input) })
    }
  } else if (json.type === 'rate_limit_event') {
    parsed.limited = json.rate_limit_info?.status === 'rejected'
  } else if (json.type === 'result') {
    const errors = Array.isArray(json.errors) ? json.errors.join('\n') : ''
    parsed.result = { isError: !!json.is_error, text: String(json.result ?? errors) }
  }
  return parsed
}

export function classifyFailure(text: string): FailureKind {
  if (/not logged in|\/login|invalid api key|authentication/i.test(text)) return 'auth'
  if (/usage limit|rate limit|limit reached|hit your limit/i.test(text)) return 'limit'
  if (/no conversation found/i.test(text)) return 'resume'
  return 'crash'
}
