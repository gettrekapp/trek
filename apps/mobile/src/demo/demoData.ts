// The demo server's sample project (apps/mobile/src/demo): what someone sees after Try the demo. A
// fresh copy on every call, its times relative to `now` ("2 hours ago" stays true). Pure.
import type { Automation, ChangedFile, CommitInfo, HistoryEvent, Project, Repository, ReviewComment, Session, Worktree } from '../shared.ts'
import { parseCron, slotsBetween } from '../shared.ts'
import { CODEX_TICKS, SCROLLBACK } from './demoScripts.ts'

export const DEMO_PROJECT_ID = 'demo-acme-web'
export const DEMO_PROJECT_NAME = 'acme-web'
export const DEMO_REPO_ID = 'demo-repo'
export const DEMO_ROOT = '/home/demo/code/acme-web'
export const DEMO_NIGHTLY_ID = 'auto-nightly'
const CHECKOUT_HEAD = '7b2e9d4c1a8f3e6b0d5c2a9f8e7d6c5b4a3f2e1d'
const PR_URL = 'https://github.com/example/acme-web/pull/42'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** A worktree's changes, as worktree.changes / diff / commits read them */
export interface DemoChanges {
  /** Every changed file against main, with its patch */
  files: { file: ChangedFile; patch: string }[]
  /** Paths among `files` that are not committed yet */
  uncommitted: string[]
  /** Newest first; `paths`: the files the commit touched */
  commits: { info: CommitInfo; paths: string[] }[]
}

export interface DemoState {
  project: Project & { automations: Automation[] }
  /** By worktree id */
  changes: Record<string, DemoChanges>
  /** Newest first */
  history: HistoryEvent[]
  /** The branches repo.listBranches offers */
  branches: string[]
  /** By session id: when it entered attention or done (the attention list's `since`) */
  since: Record<string, number>
  /** By session id: terminal text not yet handed to a terminal; given to it when one opens */
  scrollback: Record<string, string>
  /** By session id: the lines a working session still has to print (one per tick) */
  ticking: Record<string, string[]>
}

const patch = (...l: string[]): string => `${l.join('\n')}\n`

const ORDER_SUMMARY = patch(
  'diff --git a/src/checkout/OrderSummary.tsx b/src/checkout/OrderSummary.tsx',
  'index 3f2a1c4..8b9d0e2 100644',
  '--- a/src/checkout/OrderSummary.tsx',
  '+++ b/src/checkout/OrderSummary.tsx',
  '@@ -1,12 +1,18 @@',
  " import { formatPrice } from '../lib/money'",
  "+import { Badge } from '../ui/Badge'",
  " import type { Cart } from './types'",
  ' ',
  ' export function OrderSummary({ cart }: { cart: Cart }) {',
  '-  const total = cart.items.reduce((sum, item) => sum + item.price, 0)',
  '+  const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0)',
  '+  const total = subtotal + cart.shipping - cart.discount',
  '   return (',
  '     <section className="order-summary">',
  '       <h2>Order summary</h2>',
  '-      <p>Total: {formatPrice(total)}</p>',
  '+      <dl>',
  '+        <dt>Subtotal</dt><dd>{formatPrice(subtotal)}</dd>',
  '+        <dt>Shipping</dt><dd>{cart.shipping === 0 ? <Badge>Free</Badge> : formatPrice(cart.shipping)}</dd>',
  '+        <dt>Total</dt><dd className="total">{formatPrice(total)}</dd>',
  '+      </dl>',
  '     </section>',
  '   )',
  ' }'
)

const BADGE = patch(
  'diff --git a/src/ui/Badge.tsx b/src/ui/Badge.tsx',
  'new file mode 100644',
  'index 0000000..5c1d7a3',
  '--- /dev/null',
  '+++ b/src/ui/Badge.tsx',
  '@@ -0,0 +1,5 @@',
  "+import type { ReactNode } from 'react'",
  '+',
  '+export function Badge({ children }: { children: ReactNode }) {',
  '+  return <span className="badge">{children}</span>',
  '+}'
)

const SUMMARY_CSS = patch(
  'diff --git a/src/checkout/order-summary.css b/src/checkout/order-summary.css',
  'index 1a2b3c4..4d5e6f7 100644',
  '--- a/src/checkout/order-summary.css',
  '+++ b/src/checkout/order-summary.css',
  '@@ -3,3 +3,11 @@',
  '   padding: 16px;',
  '   border-radius: 8px;',
  ' }',
  '+',
  '+.order-summary dl {',
  '+  display: grid;',
  '+  grid-template-columns: 1fr auto;',
  '+  row-gap: 4px;',
  '+}',
  '+',
  '+.order-summary .total { font-weight: 600; }'
)

const SESSION_TS = patch(
  'diff --git a/src/auth/session.ts b/src/auth/session.ts',
  'index 9e8d7c6..a1b2c3d 100644',
  '--- a/src/auth/session.ts',
  '+++ b/src/auth/session.ts',
  '@@ -8,7 +8,11 @@ export interface SessionOptions {',
  ' }',
  ' ',
  ' const IDLE_TIMEOUT_MS = 10 * 60 * 1000',
  ' ',
  ' export function isExpired(session: Session, now = Date.now()): boolean {',
  '-  return now - session.lastSeen > IDLE_TIMEOUT_MS',
  '+  return now - session.lastActivity > IDLE_TIMEOUT_MS',
  ' }',
  '+',
  '+export function touch(session: Session, now = Date.now()): Session {',
  '+  return { ...session, lastActivity: now }',
  '+}'
)

const SESSION_TEST = patch(
  'diff --git a/src/auth/session.test.ts b/src/auth/session.test.ts',
  'new file mode 100644',
  'index 0000000..77aa11b',
  '--- /dev/null',
  '+++ b/src/auth/session.test.ts',
  '@@ -0,0 +1,16 @@',
  "+import { test, expect } from 'vitest'",
  "+import { isExpired, touch } from './session'",
  '+',
  "+const base = { id: 's1', userId: 'u1', lastActivity: 0 }",
  '+',
  "+test('a session idle for 9 minutes is still valid', () => {",
  '+  expect(isExpired(base, 9 * 60 * 1000)).toBe(false)',
  '+})',
  '+',
  "+test('activity resets the idle clock', () => {",
  '+  expect(isExpired(touch(base, 8 * 60 * 1000), 15 * 60 * 1000)).toBe(false)',
  '+})',
  '+',
  "+test('a session idle for 11 minutes has expired', () => {",
  '+  expect(isExpired(base, 11 * 60 * 1000)).toBe(true)',
  '+})'
)

const file = (path: string, status: ChangedFile['status'], added: number, deleted: number): ChangedFile => ({ path, status, added, deleted, binary: false })

export function initialDemoState(now: number): DemoState {
  const ago = (ms: number): number => now - ms
  const claude = { provider: 'claude' as const }

  const checkoutClaude: Session = { id: 's-checkout-claude', title: 'Redesign checkout summary', llm: claude, queue: [`Pull request #42 (${PR_URL}) changed:\n- All checks passed.`], status: 'done' }
  const loginClaude: Session = {
    id: 's-login-claude',
    title: 'Fix login timeout',
    llm: claude,
    queue: [],
    status: 'attention',
    decision: { question: 'Raise the idle timeout to 30 minutes, or refresh the session on activity?', at: ago(6 * MIN) }
  }
  const loginCodex: Session = { id: 's-login-codex', title: 'Add timeout tests', llm: { provider: 'codex' }, queue: [], status: 'working' }
  const nightly: Session = {
    id: 's-nightly',
    title: 'Nightly dependency check',
    llm: claude,
    queue: [],
    status: 'done',
    context: { kind: 'automation', automationId: DEMO_NIGHTLY_ID }
  }

  const comments: ReviewComment[] = [
    {
      id: 'c-1',
      source: { kind: 'branch' },
      path: 'src/checkout/OrderSummary.tsx',
      side: 'new',
      line: 7,
      lineText: '  const total = subtotal + cart.shipping - cart.discount',
      body: 'Can the discount ever be larger than the subtotal? Clamp the total at zero.',
      at: ago(40 * MIN)
    },
    {
      id: 'c-2',
      source: { kind: 'branch' },
      path: 'src/checkout/OrderSummary.tsx',
      side: 'new',
      line: 13,
      lineText: '        <dt>Shipping</dt><dd>{cart.shipping === 0 ? <Badge>Free</Badge> : formatPrice(cart.shipping)}</dd>',
      body: 'Free shipping now shows a badge: worth a snapshot test.',
      at: ago(52 * MIN),
      by: { kind: 'mcp', sessionTitle: 'Redesign checkout summary' }
    }
  ]

  const main: Worktree = { id: 'wt-main', name: 'acme-web', path: DEMO_ROOT, branch: 'main', head: 'e4c1a9f2b7d3c8e1f0a2b4c6d8e0f1a3b5c7d9e2', isMain: true, dirty: false, ahead: 0, behind: 0, loaded: true, sessions: [] }
  const checkout: Worktree = {
    id: 'wt-checkout',
    name: 'feature/checkout-redesign',
    path: `${DEMO_ROOT}-feature-checkout-redesign`,
    branch: 'feature/checkout-redesign',
    head: CHECKOUT_HEAD,
    isMain: false,
    dirty: true,
    ahead: 2,
    behind: 0,
    loaded: true,
    sessions: [checkoutClaude],
    prNotice: { title: 'PR #42', text: 'Checks passed — prompt queued for Redesign checkout summary', url: PR_URL, at: ago(25 * MIN) },
    review: { revision: 2, comments },
    reviewRevision: 2
  }
  const login: Worktree = {
    id: 'wt-login',
    name: 'fix/login-timeout',
    path: `${DEMO_ROOT}-fix-login-timeout`,
    branch: 'fix/login-timeout',
    head: '3c9a1e7f5b2d8c4a6e0f9b3d7c1a5e8f2b6d0c4a',
    isMain: false,
    dirty: true,
    ahead: 1,
    behind: 0,
    loaded: true,
    sessions: [loginClaude, loginCodex]
  }

  const repo: Repository = {
    id: DEMO_REPO_ID,
    name: 'acme-web',
    path: DEMO_ROOT,
    branchData: {
      'feature/checkout-redesign': {
        tag: 'In Review',
        customTags: ['frontend'],
        note: 'Waiting on design sign-off for the mobile layout.',
        pr: PR_URL,
        prWatch: { seen: { checks: `${CHECKOUT_HEAD} passing`, conflict: false } }
      },
      'fix/login-timeout': {
        tag: 'In Progress',
        ticket: 'ACME-118',
        note: 'Users on slow networks get signed out mid-checkout.'
      }
    },
    worktrees: [main, checkout, login]
  }

  const nightlySpec = parseCron('0 2 * * *')
  const nightlySlots = slotsBetween(nightlySpec, 'UTC', now - 10 * DAY, now)
  const lastNightly = nightlySlots[nightlySlots.length - 1]
  const [ranLatest, ranBefore] = [nightlySlots[nightlySlots.length - 2], nightlySlots[nightlySlots.length - 3]]
  const changelogCreated = ago(20 * DAY)
  const changelogSlots = slotsBetween(parseCron('0 9 * * 1'), 'UTC', changelogCreated, now)

  const automations: Automation[] = [
    {
      id: DEMO_NIGHTLY_ID,
      name: 'Nightly dependency check',
      prompt: 'Check for outdated or vulnerable dependencies and open a PR with safe upgrades.',
      schedule: { cron: '0 2 * * *', tz: 'UTC' },
      enabled: true,
      createdAt: ago(20 * DAY),
      lastSlot: lastNightly,
      missed: { since: lastNightly, count: 1 },
      history: [
        { at: ranLatest + MIN, slot: ranLatest, trigger: 'schedule', outcome: 'ran', sessionId: nightly.id },
        { at: ranBefore + MIN, slot: ranBefore, trigger: 'schedule', outcome: 'ran', sessionId: nightly.id }
      ]
    },
    {
      id: 'auto-changelog',
      name: 'Weekly changelog',
      prompt: "Summarise the week's merged pull requests into CHANGELOG.md.",
      schedule: { cron: '0 9 * * 1', tz: 'UTC' },
      enabled: false,
      createdAt: changelogCreated,
      lastSlot: changelogSlots[changelogSlots.length - 1] ?? changelogCreated,
      history: []
    }
  ]

  const project: DemoState['project'] = {
    id: DEMO_PROJECT_ID,
    name: DEMO_PROJECT_NAME,
    settings: {
      customTags: [
        { id: 'frontend', name: 'frontend', color: '#55c7e4' },
        { id: 'needs-design', name: 'needs design', color: '#e2a336' }
      ],
      terminalButtons: [
        { id: 'qb-tests', label: 'Run tests', text: 'Run the test suite and fix anything that fails.' },
        { id: 'qb-pr', label: 'Open PR', text: 'Open a pull request for [branch].' },
        { id: 'qb-explain', label: 'Explain…', text: 'Explain {WHAT} in this codebase.' }
      ],
      globalTerminalButtons: [{ id: 'qb-standup', label: 'Standup', text: 'Summarise what changed on every branch since yesterday.' }]
    },
    repositories: [repo],
    globalSessions: [nightly],
    automations
  }

  let n = 0
  const ev = (at: number, branch: string, kind: HistoryEvent['kind'], extra: Partial<HistoryEvent> = {}): HistoryEvent => ({
    id: `h-seed-${++n}`,
    at,
    repoId: DEMO_REPO_ID,
    branch,
    kind,
    actor: { kind: 'user' },
    ...extra
  })
  const tag = (name: string, color: string) => ({ id: name, text: name, color })
  const history: HistoryEvent[] = [
    ev(ago(3 * DAY), 'feature/checkout-redesign', 'created'),
    ev(ago(3 * DAY - MIN), 'feature/checkout-redesign', 'status', { to: tag('In Progress', '#5dabef') }),
    ev(ago(2 * DAY), 'feature/checkout-redesign', 'label.added', {
      to: { id: 'frontend', text: 'frontend', color: '#55c7e4' },
      actor: { kind: 'mcp', sessionTitle: 'Redesign checkout summary' },
      reason: 'The branch only touches the checkout UI'
    }),
    ev(ago(2 * DAY - HOUR), 'feature/checkout-redesign', 'note', { to: { text: 'added' } }),
    ev(ago(DAY + 2 * HOUR), 'feature/checkout-redesign', 'pr', { to: { text: PR_URL } }),
    ev(ago(DAY + 2 * HOUR - MIN), 'feature/checkout-redesign', 'prWatch.on'),
    ev(ago(20 * HOUR), 'feature/checkout-redesign', 'status', { from: tag('In Progress', '#5dabef'), to: tag('In Review', '#b8a8f0') }),
    ev(ago(5 * HOUR), 'fix/login-timeout', 'created'),
    ev(ago(5 * HOUR - MIN), 'fix/login-timeout', 'ticket', { to: { text: 'ACME-118' } }),
    ev(ago(5 * HOUR - 2 * MIN), 'fix/login-timeout', 'status', { to: tag('In Progress', '#5dabef') }),
    ev(ago(4 * HOUR), 'fix/login-timeout', 'note', { to: { text: 'added' } })
  ].sort((a, b) => b.at - a.at)

  const changes: Record<string, DemoChanges> = {
    'wt-main': {
      files: [],
      uncommitted: [],
      commits: [
        { info: { sha: 'e4c1a9f2b7d3c8e1f0a2b4c6d8e0f1a3b5c7d9e2', subject: 'Merge pull request #41 from example/fix/cart-rounding', author: 'Sam Rivera', at: ago(2 * DAY) }, paths: [] },
        { info: { sha: 'a17d3b90c4e25f6718293a4b5c6d7e8f90a1b2c3', subject: 'Round cart prices half-up', author: 'Sam Rivera', at: ago(2 * DAY + HOUR) }, paths: [] },
        { info: { sha: '5be02c61d9f3a7b8c0e1d2f3a4b5c6d7e8f9a0b1', subject: 'Release 2026.11', author: 'Alex Chen', at: ago(6 * DAY) }, paths: [] }
      ]
    },
    'wt-checkout': {
      files: [
        { file: file('src/checkout/OrderSummary.tsx', 'modified', 8, 2), patch: ORDER_SUMMARY },
        { file: file('src/ui/Badge.tsx', 'added', 5, 0), patch: BADGE },
        { file: file('src/checkout/order-summary.css', 'modified', 8, 0), patch: SUMMARY_CSS }
      ],
      uncommitted: ['src/checkout/order-summary.css'],
      commits: [
        { info: { sha: CHECKOUT_HEAD, subject: 'Show free shipping as a badge', author: 'Claude', at: ago(DAY + 3 * HOUR) }, paths: ['src/checkout/OrderSummary.tsx', 'src/ui/Badge.tsx'] },
        { info: { sha: '2f8c6a1e5d7b9c3a0e4f6b8d1a3c5e7f9b0d2a4c', subject: 'Split the order total into subtotal, shipping and total', author: 'Claude', at: ago(DAY + 4 * HOUR) }, paths: ['src/checkout/OrderSummary.tsx'] }
      ]
    },
    'wt-login': {
      files: [
        { file: file('src/auth/session.ts', 'modified', 5, 1), patch: SESSION_TS },
        { file: file('src/auth/session.test.ts', 'added', 16, 0), patch: SESSION_TEST }
      ],
      uncommitted: ['src/auth/session.test.ts'],
      commits: [{ info: { sha: '3c9a1e7f5b2d8c4a6e0f9b3d7c1a5e8f2b6d0c4a', subject: 'Track last activity instead of last request', author: 'Claude', at: ago(3 * HOUR) }, paths: ['src/auth/session.ts'] }]
    }
  }

  return {
    project,
    changes,
    history,
    branches: ['main', 'feature/checkout-redesign', 'fix/login-timeout', 'feature/saved-carts', 'chore/upgrade-vite', 'release/2026.11'],
    since: { [checkoutClaude.id]: ago(50 * MIN), [loginClaude.id]: ago(6 * MIN), [nightly.id]: ranLatest + 5 * MIN },
    scrollback: { ...SCROLLBACK },
    ticking: { [loginCodex.id]: [...CODEX_TICKS] }
  }
}
