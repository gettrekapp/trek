import test from 'node:test'
import assert from 'node:assert/strict'
import { numberedLines, patchBody } from '../src/shared/changes.ts'
import {
  MAX_REVIEW_LINE_TEXT,
  isCommitSha,
  isOutdated,
  placeComments,
  reviewLineText,
  reviewPrompt,
  sameSource,
  sourceKey,
  sourceLabel
} from '../src/shared/review.ts'

const PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -10,2 +10,3 @@ fn()',
  ' ten',
  '+ten and a half',
  ' eleven',
  '\\ No newline at end of file',
  ''
].join('\n')

test('numberedLines numbers each side from the hunk headers', () => {
  const lines = numberedLines(patchBody(PATCH))
  assert.deepEqual(
    lines.map((l) => [l.kind, l.side, l.line, l.text]),
    [
      ['hunk', undefined, undefined, '@@ -1,3 +1,3 @@'],
      ['context', 'new', 1, 'one'],
      ['del', 'old', 2, 'two'],
      ['add', 'new', 2, 'TWO'],
      ['context', 'new', 3, 'three'],
      ['hunk', undefined, undefined, '@@ -10,2 +10,3 @@ fn()'],
      ['context', 'new', 10, 'ten'],
      ['add', 'new', 11, 'ten and a half'],
      ['context', 'new', 12, 'eleven'],
      ['note', undefined, undefined, '\\ No newline at end of file']
    ]
  )
})

test('numberedLines: lines before a hunk (a mode-only change) have no number', () => {
  const lines = numberedLines(['old mode 100644', 'new mode 100755'])
  assert.ok(lines.every((l) => l.kind === 'note' && l.line === undefined))
})

test('numberedLines: a new file starts at line 1 of the new side', () => {
  const lines = numberedLines(['@@ -0,0 +1,2 @@', '+a', '+b'])
  assert.deepEqual(lines.slice(1).map((l) => [l.side, l.line]), [['new', 1], ['new', 2]])
})

test('isCommitSha takes only full lowercase hex ids', () => {
  assert.equal(isCommitSha('a'.repeat(40)), true)
  assert.equal(isCommitSha('b'.repeat(64)), true)
  for (const bad of ['a'.repeat(39), 'A'.repeat(40), '--output=x', 'HEAD', 'a'.repeat(40) + '^', 'g'.repeat(40), 42, undefined]) {
    assert.equal(isCommitSha(bad), false, String(bad))
  }
})

test('sources: same, key and label', () => {
  const sha = 'c'.repeat(40)
  assert.equal(sameSource({ kind: 'branch' }, { kind: 'branch' }), true)
  assert.equal(sameSource({ kind: 'commit', sha }, { kind: 'commit', sha }), true)
  assert.equal(sameSource({ kind: 'commit', sha }, { kind: 'commit', sha: 'd'.repeat(40) }), false)
  assert.equal(sameSource({ kind: 'uncommitted' }, { kind: 'branch' }), false)
  assert.equal(sourceKey({ kind: 'commit', sha }), `commit:${sha}`)
  assert.equal(sourceLabel({ kind: 'commit', sha }, 'Fix it'), 'Commit ccccccc (Fix it)')
  assert.equal(sourceLabel({ kind: 'uncommitted' }), 'Uncommitted changes')
})

test('reviewLineText drops control characters, keeps tabs and cuts long lines', () => {
  assert.equal(reviewLineText('\ta\u001b[31mb\r'), '\ta[31mb')
  assert.equal(reviewLineText('x'.repeat(MAX_REVIEW_LINE_TEXT + 10)).length, MAX_REVIEW_LINE_TEXT)
})

const comment = (over) => ({
  id: 'c1',
  source: { kind: 'branch' },
  path: 'a.txt',
  side: 'new',
  line: 2,
  lineText: 'TWO',
  body: 'Why upper case?',
  at: 1,
  ...over
})

test('placeComments: a matching line holds its comment; a changed or missing one is outdated', () => {
  const lines = numberedLines(patchBody(PATCH))
  const onTwo = comment({ id: 'a' })
  const removed = comment({ id: 'b', side: 'old', line: 2, lineText: 'two' })
  const changed = comment({ id: 'c', line: 11, lineText: 'ten and a quarter' })
  const gone = comment({ id: 'd', line: 99, lineText: 'x' })
  const { byLine, outdated } = placeComments([onTwo, removed, changed, gone], lines)
  assert.deepEqual([...byLine.entries()].map(([i, cs]) => [i, cs.map((c) => c.id)]), [[3, ['a']], [2, ['b']]])
  assert.deepEqual(outdated.map((c) => c.id), ['c', 'd'])
})

test('reviewPrompt groups by source, then file and line, quoting each line', () => {
  const sha = 'e'.repeat(40)
  const text = reviewPrompt('feature', [
    comment({ id: '1', path: 'b.txt', line: 5, lineText: 'five', body: 'B five' }),
    comment({ id: '2', source: { kind: 'commit', sha }, path: 'a.txt', line: 1, lineText: 'one', body: 'In the commit' }),
    comment({ id: '3', path: 'a.txt', side: 'old', line: 2, lineText: 'two', body: 'Keep this' })
  ])
  assert.equal(
    text,
    [
      'Review comments on the changes in feature (3 comments). Each quotes the line as it read when the comment was written; the file may have changed since. Address each one.',
      '## The branch against its base',
      'a.txt, removed line 2:\n> two\nKeep this',
      'b.txt, line 5:\n> five\nB five',
      '## Commit eeeeeee',
      'a.txt, line 1:\n> one\nIn the commit'
    ].join('\n\n')
  )
})

test('isOutdated: no patch, no such line, or another text', () => {
  const c = comment({ side: 'new', line: 2, lineText: 'TWO' })
  assert.equal(isOutdated(c, PATCH), false)
  assert.equal(isOutdated({ ...c, lineText: 'two' }, PATCH), true)
  assert.equal(isOutdated({ ...c, line: 99 }, PATCH), true)
  assert.equal(isOutdated(c, undefined), true)
})
