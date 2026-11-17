// The demo server's terminal text (apps/mobile/src/demo): each sample session's scrollback, the
// lines the working session prints while the demo runs, and the canned replies to a prompt. ANSI
// colours and \r\n line ends, as a pty sends them. Pure.

const CSI = '\u001b['
const paint = (code: string) => (s: string): string => `${CSI}${code}m${s}${CSI}0m`
const dim = paint('2')
const bold = paint('1')
const cyan = paint('36')
const green = paint('32')
const yellow = paint('33')

/** Lines as a pty prints them */
export const lines = (...l: string[]): string => l.map((s) => `${s}\r\n`).join('')

const step = (s: string): string => `${cyan('●')} ${s}`

/** Each sample session's terminal so far, by session id */
export const SCROLLBACK: Record<string, string> = {
  's-checkout-claude': lines(
    dim('claude · feature/checkout-redesign'),
    '',
    `${bold('>')} Split the order total into subtotal, shipping and total, and show free shipping as a badge.`,
    '',
    step('Reading src/checkout/OrderSummary.tsx'),
    step('Editing src/checkout/OrderSummary.tsx (+8 −2)'),
    step('Creating src/ui/Badge.tsx (+5)'),
    step('Running npm test'),
    green('  ✓ 42 tests passed'),
    '',
    'Done. The summary lists subtotal, shipping and total, and free shipping shows a "Free" badge.',
    'I left a review comment suggesting a snapshot test for the badge.'
  ),
  's-login-claude': lines(
    dim('claude · fix/login-timeout'),
    '',
    `${bold('>')} Users on slow networks get signed out mid-checkout. Find out why and fix it.`,
    '',
    step('Reading src/auth/session.ts'),
    step('Reading src/auth/middleware.ts'),
    '',
    'Sessions expire after 10 minutes without a request, and a slow checkout can take longer.',
    'Two ways to fix it:',
    '  1. Raise the idle timeout to 30 minutes',
    '  2. Refresh the session on any activity, client heartbeats included',
    '',
    yellow('? Waiting for you: which approach should I take?')
  ),
  's-login-codex': lines(
    dim('codex · fix/login-timeout'),
    '',
    `${bold('>')} Add tests for the session idle timeout.`,
    '',
    '• Created src/auth/session.test.ts',
    '• Running vitest --run src/auth'
  ),
  's-global-claude': lines(
    dim('claude · Global'),
    '',
    `${bold('>')} Which branches have open pull requests?`,
    '',
    'Two: feature/checkout-redesign (#42, checks passing) and fix/login-timeout (#44, waiting on a decision).'
  ),
  's-nightly': lines(
    dim('claude · Automation · Nightly dependency check'),
    '',
    `${bold('>')} Check for outdated or vulnerable dependencies and open a PR with safe upgrades.`,
    '',
    step('Running npm outdated'),
    '  react 18.3.1 → 18.3.2 (patch)',
    '  vite 5.4.10 → 5.4.11 (patch)',
    step('Running npm audit'),
    green('  found 0 vulnerabilities'),
    '',
    'Two patch upgrades are available and safe. Opened PR #45 "chore: patch upgrades".'
  )
}

/** What the working Codex session prints, one entry every few seconds; after the last it is done */
export const CODEX_TICKS: string[] = [
  lines(green('  ✓ a session idle for 9 minutes is still valid')),
  lines(green('  ✓ activity resets the idle clock')),
  lines('• Checking the 10 minute boundary'),
  lines(green('  ✓ a session idle for 11 minutes has expired')),
  lines('', 'Added 3 tests in src/auth/session.test.ts. All pass.')
]

/** The nightly automation's run, a chunk per step */
export const NIGHTLY_RUN: string[] = [
  lines(step('Running npm outdated')),
  lines('  react 18.3.1 → 18.3.2 (patch)', '  vite 5.4.10 → 5.4.11 (patch)'),
  lines(step('Running npm audit')),
  lines(green('  found 0 vulnerabilities')),
  lines('', 'Two patch upgrades are available and safe. Opened PR #46 "chore: patch upgrades".')
]

/** One line of at most `max` characters, control characters removed */
export function oneLine(text: string, max = 300): string {
  const flat = Array.from(text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim())
  return flat.length > max ? `${flat.slice(0, max - 1).join('')}…` : flat.join('')
}

/** A prompt as the terminal shows it being typed in */
export function promptEcho(text: string): string {
  return `\r\n${bold('>')} ${oneLine(text)}\r\n\r\n`
}

/** A new session's first lines */
export function sessionBanner(agent: string, where: string): string {
  return lines(dim(`${agent.toLowerCase()} · ${where}`), '', 'Ready. This is a demo session: send it a prompt.')
}

/** A loaded worktree's session, resumed */
export const RESUMED = lines('', dim('Resumed.'))

const REPLIES: { match: RegExp; lines: string[] }[] = [
  {
    match: /review/,
    lines: [
      step('Reading the review comments'),
      step('Editing src/checkout/OrderSummary.tsx'),
      '  Clamped the total at zero and added a snapshot test for the badge.',
      step('Running npm test'),
      green('  ✓ 43 tests passed'),
      '',
      'Both review comments are addressed.'
    ]
  },
  {
    match: /\btests?\b/,
    lines: [step('Running npm test'), green('  ✓ 44 tests passed'), '', 'All tests pass.']
  },
  {
    match: /refresh|^\s*2\b/,
    lines: [
      step('Editing src/auth/session.ts'),
      '  Added touch() and called it from the auth middleware on every request',
      step('Running npm test'),
      green('  ✓ 44 tests passed'),
      '',
      'Done: sessions now refresh on activity.'
    ]
  },
  {
    match: /30 minutes|timeout|^\s*1\b/,
    lines: [
      step('Editing src/auth/session.ts'),
      '  IDLE_TIMEOUT_MS is now 30 minutes',
      step('Running npm test'),
      green('  ✓ 44 tests passed'),
      '',
      'Done: the idle timeout is 30 minutes.'
    ]
  }
]

/** The canned reply to a prompt, a chunk per step */
export function replyFor(text: string): string[] {
  const t = text.toLowerCase()
  const pick = REPLIES.find((r) => r.match.test(t))
  const body = pick
    ? pick.lines
    : [
        step('Looking into it'),
        step('Reading the relevant files'),
        '',
        `This is Trek's demo server, so no agent really ran. On your own server, the agent would now be working on: "${oneLine(text, 120)}"`
      ]
  return body.map((l) => lines(l))
}
