// Size limits on what clients send for sessions: pty writes, prompts, queues
// and titles. Shared by the session handlers, the SessionManager and
// project.import; imports nothing from either, so neither forms a cycle.
import { codedError } from '../errors.ts'

/** The most a single pty.write (or session.sendPrompt) may carry, in UTF-16 code units. */
export const MAX_PTY_WRITE = 1024 * 1024
/** The longest queued prompt, in UTF-16 code units. */
export const MAX_QUEUE_ENTRY = 100_000
/** The most prompts a session's queue holds. */
export const MAX_QUEUE_LENGTH = 100
export const MAX_TITLE_LENGTH = 200
/** The most session types a project holds. */
export const MAX_SESSION_TYPES = 100
/** The widest and tallest pty (and headless screen) a client may ask for. */
export const MAX_COLS = 500
export const MAX_ROWS = 200
/** The most session records one project holds, running or not. */
export const MAX_SESSIONS_PER_PROJECT = 500
/** The longest question a decision request carries. */
export const MAX_QUESTION_LENGTH = 1000

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/** A session title: at most MAX_TITLE_LENGTH characters, no control characters. */
export function checkTitle(title: string, field: string): string {
  if (title.length > MAX_TITLE_LENGTH) throw bad(`${field} must be at most ${MAX_TITLE_LENGTH} characters`)
  if (/[\u0000-\u001f\u007f-\u009f]/.test(title)) throw bad(`${field} must not contain control characters`)
  return title
}

/** A whole session queue: at most MAX_QUEUE_LENGTH non-empty strings of at most MAX_QUEUE_ENTRY each. */
export function checkQueue(queue: unknown, field: string): string[] {
  if (!Array.isArray(queue) || queue.some((q: unknown) => typeof q !== 'string' || q === '')) {
    throw bad(`${field} must be an array of non-empty strings`)
  }
  if (queue.length > MAX_QUEUE_LENGTH) throw bad(`${field} must hold at most ${MAX_QUEUE_LENGTH} prompts`)
  if (queue.some((q: string) => q.length > MAX_QUEUE_ENTRY)) throw bad(`each prompt in ${field} must be at most ${MAX_QUEUE_ENTRY} characters`)
  return [...queue] as string[]
}

/** A decision's question: a non-empty string, trimmed, at most MAX_QUESTION_LENGTH characters. */
export function checkQuestion(value: unknown, field: string): string {
  const question = typeof value === 'string' ? value.trim() : ''
  if (!question) throw bad(`${field} is required`)
  if (question.length > MAX_QUESTION_LENGTH) throw bad(`${field} must be at most ${MAX_QUESTION_LENGTH} characters`)
  return question
}
