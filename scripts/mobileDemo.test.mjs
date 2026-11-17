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
    // Every session in a loaded worktree has a terminal
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

test('demo: disposing the server closes its connections for good', async () => {
  const h = harness()
  try {
    await until(() => h.conn.status === 'connected')
    h.server.dispose()
    await until(() => h.conn.status !== 'connected' && h.conn.status !== 'connecting')
    assert.equal(h.conn.removed, true)
    await new Promise((r) => setTimeout(r, 50))
    assert.notEqual(h.conn.status, 'connecting')
    assert.notEqual(h.conn.status, 'connected')
  } finally {
    h.close()
  }
})

test('demo: a reconnect resubscribes and a terminal re-attach replays', async () => {
  const h = harness()
  try {
    const project = watch(h.reg, `project:${DEMO_PROJECT_ID}`)
    await until(() => project.snapshot)
    const ptyId = project.snapshot.repositories[0].worktrees[2].sessions[0].ptyId
    let out = ''
    let reattached = false
    await h.reg.ptys.attach(ptyId, { onData: (d) => (out += d), onExit() {}, onReset() { out = '' }, onReattach() { reattached = true } })
    assert.ok(out.includes('Waiting for you'))
    project.snapshot = null
    h.conn.reconnect()
    await until(() => project.snapshot)
    await until(() => h.conn.status === 'connected')
    assert.ok(project.snapshot.repositories[0].worktrees.length === 3)
    await until(() => reattached && out.includes('Waiting for you'))
  } finally {
    h.close()
  }
})

test('demo: a change reaches the mirror, and an unsubscribed topic gets nothing', async () => {
  const h = harness()
  try {
    const topic = `project:${DEMO_PROJECT_ID}`
    const project = watch(h.reg, topic)
    await until(() => project.snapshot)
    h.server.state.project.repositories[0].branchData['main'] = { note: 'hello' }
    h.server.changed()
    await until(() => project.snapshot.repositories[0].branchData.main?.note === 'hello')
    project.off()
    await until(() => ![...h.server.connectionTopics()].some((t) => t === topic))
    h.server.state.project.repositories[0].branchData['main'] = { note: 'again' }
    h.server.changed()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(project.snapshot.repositories[0].branchData.main.note, 'hello')
  } finally {
    h.close()
  }
})

test('demo: closing a terminal ends an attached handler', async () => {
  const h = harness()
  try {
    const project = watch(h.reg, `project:${DEMO_PROJECT_ID}`)
    await until(() => project.snapshot)
    const ptyId = project.snapshot.repositories[0].worktrees[2].sessions[0].ptyId
    let exited = false
    await h.reg.ptys.attach(ptyId, { onData() {}, onExit: () => (exited = true) })
    h.server.terminals.close(ptyId)
    await until(() => exited)
  } finally {
    h.close()
  }
})

const REPO = { projectId: DEMO_PROJECT_ID, repoId: 'demo-repo' }

test('demo: a tag change arrives as a patch and adds history', async () => {
  const h = harness()
  try {
    const project = watch(h.reg, `project:${DEMO_PROJECT_ID}`)
    await until(() => project.snapshot)
    const added = []
    h.conn.on('event', ({ event, payload }) => event === 'history.added' && added.push(payload.event))
    await h.conn.request('branch.setTag', { ...REPO, branch: 'fix/login-timeout', tag: 'In Review' })
    await until(() => project.snapshot.repositories[0].branchData['fix/login-timeout'].tag === 'In Review')
    await until(() => added.length === 1)
    assert.equal(added[0].kind, 'status')
    assert.equal(added[0].to.text, 'In Review')
    const page = await h.conn.request('history.list', { ...REPO, branch: 'fix/login-timeout' })
    assert.equal(page.events[0].id, added[0].id)
    assert.equal(page.more, false)
  } finally {
    h.close()
  }
})

test('demo: the note is compare-and-set', async () => {
  const h = harness()
  try {
    await until(() => h.conn.status === 'connected')
    await assert.rejects(h.conn.request('branch.setNote', { ...REPO, branch: 'fix/login-timeout', note: 'x', expected: 'not the note' }), { code: 'CONFLICT' })
    await h.conn.request('branch.setNote', { ...REPO, branch: 'fix/login-timeout', note: 'New note', expected: 'Users on slow networks get signed out mid-checkout.' })
    assert.equal(h.server.state.project.repositories[0].branchData['fix/login-timeout'].note, 'New note')
  } finally {
    h.close()
  }
})

test('demo: custom tags, ticket, PR and its watch', async () => {
  const h = harness()
  try {
    await until(() => h.conn.status === 'connected')
    const branch = 'fix/login-timeout'
    await h.conn.request('branch.setCustomTags', { ...REPO, branch, customTags: ['needs-design'] })
    await h.conn.request('branch.setTicket', { ...REPO, branch, ticket: 'ACME-120' })
    await assert.rejects(h.conn.request('branch.setPrWatch', { ...REPO, branch, watch: true }), { code: 'BAD_REQUEST' })
    await h.conn.request('branch.setPr', { ...REPO, branch, pr: 'https://github.com/example/acme-web/pull/43' })
    await h.conn.request('branch.setPrWatch', { ...REPO, branch, watch: true })
    const data = () => h.server.state.project.repositories[0].branchData[branch]
    assert.deepEqual(data().customTags, ['needs-design'])
    assert.equal(data().ticket, 'ACME-120')
    assert.deepEqual(data().prWatch, {})
    await h.conn.request('branch.setPr', { ...REPO, branch, pr: null })
    assert.equal(data().prWatch, undefined)
    await h.conn.request('prWatch.dismiss', { projectId: DEMO_PROJECT_ID, worktreeId: 'wt-checkout' })
    assert.equal(h.server.state.project.repositories[0].worktrees[1].prNotice, undefined)
  } finally {
    h.close()
  }
})

test('demo: review comments are added, edited and removed, with the revision going up', async () => {
  const h = harness()
  try {
    await until(() => h.conn.status === 'connected')
    const ref = { projectId: DEMO_PROJECT_ID, worktreeId: 'wt-checkout' }
    const wt = () => h.server.state.project.repositories[0].worktrees[1]
    const { commentId } = await h.conn.request('review.add', { ...ref, source: { kind: 'branch' }, path: 'src/ui/Badge.tsx', side: 'new', line: 4, lineText: '  return <span className="badge">{children}</span>', body: 'Use a <strong>?' })
    assert.equal(wt().review.comments.length, 3)
    assert.equal(wt().review.revision, 3)
    await assert.rejects(h.conn.request('review.edit', { ...ref, commentId, body: 'x', expected: 'other' }), { code: 'CONFLICT' })
    await h.conn.request('review.edit', { ...ref, commentId, body: 'Keep the span.' })
    assert.equal(wt().review.comments[2].body, 'Keep the span.')
    await h.conn.request('review.remove', { ...ref, commentId })
    assert.equal(wt().review.comments.length, 2)
    await assert.rejects(h.conn.request('review.clear', { ...ref, revision: 1 }), { code: 'CONFLICT' })
    await h.conn.request('review.clear', { ...ref, revision: wt().review.revision })
    assert.equal(wt().review, undefined)
    assert.equal(wt().reviewRevision, 5)
  } finally {
    h.close()
  }
})

test('demo: a different pull request ends the watch, and a failed or no-op edit leaves no empty branch data', async () => {
  const h = harness()
  try {
    await until(() => h.conn.status === 'connected')
    const branch = 'feature/checkout-redesign'
    const repo = h.server.state.project.repositories[0]
    assert.ok(repo.branchData[branch].prWatch)
    const before = repo.branchData[branch].pr
    await h.conn.request('branch.setPr', { ...REPO, branch, pr: 'https://github.com/example/acme-web/pull/99' })
    assert.equal(repo.branchData[branch].prWatch, undefined)
    const events = h.server.state.history.filter((e) => e.branch === branch).slice(0, 2)
    assert.deepEqual(events.map((e) => e.kind), ['prWatch.off', 'pr'])
    assert.equal(events[1].from.text, before)
    await h.conn.request('branch.setTag', { ...REPO, branch: 'nothing/here', tag: '' })
    await assert.rejects(h.conn.request('branch.setPrWatch', { ...REPO, branch: 'nothing/here', watch: true }), { code: 'BAD_REQUEST' })
    assert.equal(repo.branchData['nothing/here'], undefined)
  } finally {
    h.close()
  }
})

test('demo: a session that leaves done and returns gets a new since', async () => {
  const h = harness()
  try {
    await until(() => h.conn.status === 'connected')
    const session = h.server.state.project.repositories[0].worktrees[2].sessions[0]
    const sinceKey = session.id
    assert.ok(h.server.state.since[sinceKey] !== undefined)
    const oldSession = session.status
    session.status = 'working'
    h.server.changed()
    assert.equal(h.server.state.since[sinceKey], undefined)
    const t = Date.now()
    session.status = oldSession
    h.server.changed()
    assert.ok(h.server.state.since[sinceKey] >= t)
  } finally {
    h.close()
  }
})
