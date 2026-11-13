// scripts/quickButtonTemplate.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTINS,
  parseTemplate,
  templateInputs,
  templateBuiltins,
  resolveBuiltins,
  fillTemplate,
  planQuickButton
} from '../src/shared/quickButtonTemplate.ts'

test('plain text is one text segment', () => {
  assert.deepEqual(parseTemplate('just text'), [{ kind: 'text', text: 'just text' }])
  assert.deepEqual(parseTemplate(''), [])
})

test('inputs and known built-ins become tokens', () => {
  assert.deepEqual(parseTemplate('Review {AREA} on [branch].'), [
    { kind: 'text', text: 'Review ' },
    { kind: 'input', name: 'AREA', raw: '{AREA}' },
    { kind: 'text', text: ' on ' },
    { kind: 'builtin', name: 'branch', raw: '[branch]' },
    { kind: 'text', text: '.' }
  ])
})

test('built-in names match case-insensitively and normalise to lower case', () => {
  assert.deepEqual(parseTemplate('[Branch]'), [{ kind: 'builtin', name: 'branch', raw: '[Branch]' }])
})

test('unknown brackets, markdown links and invalid braces stay literal', () => {
  assert.deepEqual(parseTemplate('[x] [text](url) [branch](url) {a b} {}'), [
    { kind: 'text', text: '[x] [text](url) [branch](url) {a b} {}' }
  ])
})

test('input names are case-sensitive and may hold digits and underscores', () => {
  assert.deepEqual(templateInputs('{a} {A} {area_2} {a}'), ['a', 'A', 'area_2'])
})

test('templateBuiltins lists each built-in once, in order', () => {
  assert.deepEqual(templateBuiltins('[pr_url] [branch] [PR_URL]'), ['pr_url', 'branch'])
})

test('every built-in has a group and a description', () => {
  for (const b of BUILTINS) {
    assert.match(b.name, /^[a-z_]+$/)
    assert.ok(b.description.length > 0, b.name)
    assert.ok(['Worktree', 'Repo & project', 'Branch', 'Session', 'Time'].includes(b.group), b.name)
  }
})
const ctx = (over = {}) => ({
  project: {
    name: 'Trek',
    worktreeTags: [{ id: 'review', name: 'In Review', color: '#fff' }],
    customTags: [
      { id: 'a', name: 'ui', color: '#fff' },
      { id: 'b', name: 'urgent', color: '#fff' }
    ],
    linearWorkspace: 'acme'
  },
  repo: {
    name: 'trek',
    path: '/r/trek',
    branchTags: { feat: 'review' },
    branchCustomTags: { feat: ['b', 'a', 'gone'] },
    branchTickets: { feat: 'TOW-12' },
    branchPullRequests: { feat: 'https://github.com/o/r/pull/42' },
    branchNotes: { feat: 'remember X' }
  },
  worktree: { id: 'wt1', name: 'feat', path: '/r/feat' },
  branch: 'feat',
  terminal: { id: 't1', title: 'Claude', sessionId: 's-1' },
  agent: 'Claude',
  now: new Date(2026, 10, 3, 9, 5),
  ...over
})

test('resolveBuiltins fills every built-in from the context', () => {
  assert.deepEqual(resolveBuiltins(ctx()), {
    worktree_id: 'wt1',
    worktree_name: 'feat',
    worktree_path: '/r/feat',
    branch: 'feat',
    repo_name: 'trek',
    repo_path: '/r/trek',
    project_name: 'Trek',
    workflow_tag: 'In Review',
    labels: 'ui, urgent',
    ticket: 'TOW-12',
    ticket_url: 'https://linear.app/acme/issue/TOW-12',
    pr_url: 'https://github.com/o/r/pull/42',
    pr_number: '42',
    note: 'remember X',
    session_title: 'Claude',
    session_id: 's-1',
    terminal_id: 't1',
    agent: 'Claude',
    date: '2026-11-03',
    time: '09:05'
  })
})

test('without a worktree (the Global panel) its built-ins are missing', () => {
  const values = resolveBuiltins(ctx({ repo: undefined, worktree: undefined, branch: undefined }))
  for (const name of ['worktree_id', 'branch', 'repo_name', 'labels', 'ticket', 'pr_url', 'pr_number', 'note']) {
    assert.equal(values[name], undefined, name)
  }
  assert.equal(values.project_name, 'Trek')
})

test('empty values and a pending session id count as missing', () => {
  const base = ctx()
  const values = resolveBuiltins({
    ...base,
    repo: { ...base.repo, branchNotes: { feat: '  ' } },
    terminal: { ...base.terminal, sessionPending: true }
  })
  assert.equal(values.note, undefined)
  assert.equal(values.session_id, undefined)
})

test('ticket_url is missing without a workspace; pr_number falls back to trailing digits', () => {
  const base = ctx()
  const values = resolveBuiltins({
    ...base,
    project: { ...base.project, linearWorkspace: undefined },
    repo: { ...base.repo, branchPullRequests: { feat: 'https://example.com/mr/7/' } }
  })
  assert.equal(values.ticket_url, undefined)
  assert.equal(values.pr_number, '7')
})

test('fillTemplate substitutes inputs and built-ins, blanks for missing ones', () => {
  const segments = parseTemplate('{A} [branch] {A} [pr_url] {B}!')
  assert.equal(fillTemplate(segments, { A: 'x' }, { branch: 'feat' }), 'x feat x  !')
})

test('planQuickButton reports inputs and missing built-ins', () => {
  assert.deepEqual(planQuickButton('{AREA} [branch] [pr_url] [branch]', { branch: 'feat' }), {
    inputs: ['AREA'],
    missing: ['pr_url'],
    needsModal: true
  })
  assert.deepEqual(planQuickButton('Continue on [branch]', { branch: 'feat' }), {
    inputs: [],
    missing: [],
    needsModal: false
  })
})
