// A review's saved shape and its `source` params (phase 5c-2). Imports nothing from the handlers,
// so the project model (load and import) and the worktree handlers can use it without a cycle.
import type { ReviewComment, ReviewDraft } from '../../../src/shared/model/types'
import type { ChangesSource } from '../../../src/shared/types'
import {
  MAX_REVIEW_BODY,
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_LINE,
  MAX_REVIEW_LINE_TEXT,
  MAX_REVIEW_PATH,
  isCommitSha
} from '../../../src/shared/review.ts'
import { codedError } from '../errors.ts'
import { isRecord } from '../validate.ts'

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/** A `source` param: absent is the branch against its base; a commit needs a full hex id. */
export function checkSource(value: unknown, field = 'source'): ChangesSource {
  if (value === undefined) return { kind: 'branch' }
  if (!isRecord(value)) throw bad(`${field} must be an object`)
  if (value.kind === 'branch' || value.kind === 'uncommitted') return { kind: value.kind }
  if (value.kind === 'commit') {
    if (!isCommitSha(value.sha)) throw bad(`${field}.sha must be a full lowercase hex commit id`)
    return { kind: 'commit', sha: value.sha }
  }
  throw bad(`${field}.kind must be "branch", "uncommitted" or "commit"`)
}

/**
 * A saved or imported draft, kept only if it has the shape the handlers write: anything else (a
 * hand-edited file, another version's) is dropped rather than reaching a client.
 */
export function cleanReview(value: unknown): ReviewDraft | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.comments)) return undefined
  const comments: ReviewComment[] = []
  for (const c of value.comments.slice(0, MAX_REVIEW_COMMENTS)) {
    if (!isRecord(c)) continue
    let source: ChangesSource
    try {
      source = checkSource(c.source)
    } catch {
      continue
    }
    const ok =
      typeof c.id === 'string' && c.id !== '' &&
      typeof c.path === 'string' && c.path !== '' && c.path.length <= MAX_REVIEW_PATH &&
      (c.side === 'old' || c.side === 'new') &&
      Number.isInteger(c.line) && (c.line as number) >= 1 && (c.line as number) <= MAX_REVIEW_LINE &&
      typeof c.lineText === 'string' && c.lineText.length <= MAX_REVIEW_LINE_TEXT &&
      typeof c.body === 'string' && c.body.trim() !== '' && c.body.length <= MAX_REVIEW_BODY &&
      typeof c.at === 'number'
    if (ok) comments.push({ id: c.id as string, source, path: c.path as string, side: c.side as 'old' | 'new', line: c.line as number, lineText: c.lineText as string, body: c.body as string, at: c.at as number })
  }
  return comments.length > 0 ? { revision: value.revision as number, comments } : undefined
}
