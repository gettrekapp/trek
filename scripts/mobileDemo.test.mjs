// The phone's demo server (apps/mobile/src/demo): a Trek server inside the app for Try the demo.
// These tests drive it through the real client SDK (ServerRegistry, TopicMirror, PtyStream), the
// way the phone does, and check that every request the phone can send is either handled by the
// demo or listed as not in it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initialDemoState, DEMO_PROJECT_ID, DEMO_REPO_ID } from '../apps/mobile/src/demo/demoData.ts'
import { parseCron, slotsBetween } from '../src/shared/cron.ts'
import { numberedLines, patchBody } from '../src/shared/changes.ts'
import { ServerRegistry, globalSocketFactory } from '../src/shared/client/index.ts'
import { DemoServer, DEMO_URL, createDemoSocketFactory } from '../apps/mobile/src/demo/index.ts'

test('demo data: a project with three worktrees, sessions, automations and history', () => {
  const state = initialDemoState(1_000_000_000_000)
  const project = state.project
  assert.equal(project.id, DEMO_PROJECT_ID)
  const repo = project.repositories[0]
  assert.equal(repo.id, DEMO_REPO_ID)
  assert.deepEqual(repo.worktrees.map((w) => w.branch), ['main', 'feature/checkout-redesign', 'fix/login-timeout'])
  assert.equal(project.automations.length, 2)
  assert.ok(state.history.length >= 10)
  // Newest first
  for (let i = 1; i < state.history.length; i++) assert.ok(state.history[i - 1].at >= state.history[i].at)
  // Automation times fall on their cron slots
  for (const auto of project.automations) {
    const spec = parseCron(auto.schedule.cron)
    const onSlot = (t) => slotsBetween(spec, auto.schedule.tz, t - 1, t).length === 1
    assert.ok(onSlot(auto.lastSlot), `${auto.name}: lastSlot`)
    for (const h of auto.history) if (h.slot !== undefined) assert.ok(onSlot(h.slot), `${auto.name}: history slot`)
  }
  const nightly = project.automations.find((a) => a.enabled)
  assert.equal(new Date(nightly.lastSlot).getUTCHours(), 2)
  assert.equal(nightly.missed.since, nightly.lastSlot)
})

test('demo data: each review comment sits on the line it quotes', () => {
  const state = initialDemoState(1_000_000_000_000)
  const checkout = state.project.repositories[0].worktrees.find((w) => w.id === 'wt-checkout')
  for (const c of checkout.review.comments) {
    const patch = state.changes['wt-checkout'].files.find((f) => f.file.path === c.path).patch
    const line = numberedLines(patchBody(patch)).find((l) => l.side === c.side && l.line === c.line)
    assert.ok(line, `line ${c.line} of ${c.path}`)
    assert.equal(line.text, c.lineText)
  }
})

/** A demo server and a real SDK connection to it, as the phone makes one */
function harness(options = {}) {
  const server = new DemoServer({ stepMs: 1, tickMs: 1_000_000, ...options })
  const registry = new ServerRegistry({ createSocket: createDemoSocketFactory(globalSocketFactory, () => server), client: 'test', clientVersion: '0' })
  const reg = registry.add({ id: 'demo', url: DEMO_URL, token: 'demo' })
  return {
    server,
    registry,
    reg,
    conn: reg.connection,
    close() {
      registry.remove('demo')
      server.dispose()
    }
  }
}

async function until(check, ms = 2000) {
  const end = Date.now() + ms
  for (;;) {
    const v = check()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** The topic's latest snapshot, kept up to date */
function watch(reg, topic) {
  const box = { snapshot: null }
  box.off = reg.mirror.subscribe(topic, (u) => {
    if (!('error' in u)) box.snapshot = u.snapshot
  })
  return box
}

test('demo: welcome with the demo capabilities', async () => {
  const h = harness()
  try {
    await until(() => h.conn.status === 'connected')
    assert.equal(h.conn.welcome.serverName, 'Demo server')
    assert.ok(h.conn.welcome.capabilities.includes('review'))
    assert.ok(!h.conn.welcome.capabilities.includes('push'))
  } finally {
    h.close()
  }
})

test('demo: the server, attention and project topics', async () => {
  const h = harness()
  try {
    const server = watch(h.reg, 'server')
    const attention = watch(h.reg, 'attention')
    const project = watch(h.reg, `project:${DEMO_PROJECT_ID}`)
    await until(() => server.snapshot && attention.snapshot && project.snapshot)
    assert.deepEqual(server.snapshot.projects, [{ id: DEMO_PROJECT_ID, name: 'acme-web' }])
    assert.equal(project.snapshot.repositories[0].worktrees.length, 3)
    const entries = attention.snapshot.entries
    assert.ok(entries.some((e) => e.sessionId === 's-login-claude' && e.decision))
    assert.ok(entries.some((e) => e.pullRequest && e.worktreeId === 'wt-checkout'))
    // Every loaded session has a terminal
    for (const w of project.snapshot.repositories[0].worktrees) for (const s of w.sessions) assert.ok(s.ptyId, s.id)
  } finally {
    h.close()
  }
})

test('demo: a request the demo does not have', async () => {
  const h = harness()
  try {
    await until(() => h.conn.status === 'connected')
    await assert.rejects(h.conn.request('push.status', {}), { message: 'Not available in the demo' })
  } finally {
    h.close()
  }
})

test('demo: a terminal replays its scrollback and echoes what is typed', async () => {
  const h = harness()
  try {
    const project = watch(h.reg, `project:${DEMO_PROJECT_ID}`)
    await until(() => project.snapshot)
    const ptyId = project.snapshot.repositories[0].worktrees[2].sessions[0].ptyId
    let out = ''
    await h.reg.ptys.attach(ptyId, { onData: (d) => (out += d), onExit() {} })
    assert.ok(out.includes('Waiting for you'))
    await h.reg.ptys.write(ptyId, 'hi\r')
    await until(() => out.endsWith('hi\r\n'))
  } finally {
    h.close()
  }
})
