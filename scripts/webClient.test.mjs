// scripts/webClient.test.mjs — the web client's page side (phase 5c-3): the routes, the browser
// relay over a fake WebSocket, the dialog queue, and `window.api` as the page makes it (the one
// server entry, attention over the page's connection, this browser's app settings, and the
// machine-only calls refused).
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathOfProject, projectOfPath } from '../src/web/routes.ts'
import { browserRelay, socketUrl } from '../src/web/browserRelay.ts'
import { answerDialog, cancelDialogById, cancelDialogs, dialogId, pendingDialogs, shiftDialog, webDialogs } from '../src/web/dialogQueue.ts'
import { createWebApi, WEB_ENTRY_ID } from '../src/web/webApi.ts'

test('routes: / is the list, /p/<id> a project; the round trip keeps odd ids', () => {
  assert.equal(projectOfPath('/'), null)
  assert.equal(projectOfPath('/p/abc'), 'abc')
  assert.equal(projectOfPath('/p/abc/'), 'abc')
  assert.equal(projectOfPath('/p/'), null)
  assert.equal(projectOfPath('/p/a/b'), null)
  assert.equal(projectOfPath('/login'), null)
  assert.equal(projectOfPath('/p/%E0%A4%A'), null)
  for (const id of ['plain', 'with space', 'a/b', 'ünï']) assert.equal(projectOfPath(pathOfProject(id)), id)
  assert.equal(pathOfProject(null), '/')
})

test('socketUrl: ws on http, wss on https, the page’s own host', () => {
  assert.equal(socketUrl({ protocol: 'http:', host: '127.0.0.1:7345' }), 'ws://127.0.0.1:7345/')
  assert.equal(socketUrl({ protocol: 'https:', host: 'trek.example.com' }), 'wss://trek.example.com/')
})

class FakeSocket {
  static made = []
  constructor(url) {
    this.url = url
    this.sent = []
    this.closed = null
    this.onopen = this.onmessage = this.onerror = this.onclose = null
    FakeSocket.made.push(this)
  }
  send(data) {
    this.sent.push(data)
  }
  close(code, reason) {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new Error('InvalidAccessError')
    this.closed = [code, reason]
  }
}

test('browserRelay: open, events by socket id, send, close (codes a page may not send become a plain close)', async () => {
  FakeSocket.made = []
  const relay = browserRelay(() => 'ws://host/', FakeSocket)
  const events = []
  const off = relay.onEvent((e) => events.push(e))
  const a = await relay.open('web')
  const b = await relay.open('web')
  assert.equal(a.ok, true)
  assert.notEqual(a.socketId, b.socketId)
  const [sa, sb] = FakeSocket.made
  assert.equal(sa.url, 'ws://host/')
  sa.onopen({})
  sa.onmessage({ data: '{"type":"welcome"}' })
  sb.onerror({})
  relay.send(a.socketId, 'hello')
  assert.deepEqual(sa.sent, ['hello'])
  relay.close(a.socketId, 1001, 'going')
  assert.deepEqual(sa.closed, [undefined, undefined])
  relay.close(b.socketId, 4000, 'mine')
  assert.deepEqual(sb.closed, [4000, 'mine'])
  sa.onclose({ code: 1006, reason: '' })
  assert.deepEqual(events, [
    { socketId: a.socketId, type: 'open' },
    { socketId: a.socketId, type: 'message', data: '{"type":"welcome"}' },
    { socketId: b.socketId, type: 'error' },
    { socketId: a.socketId, type: 'close', code: 1006, reason: '' }
  ])
  // A closed socket's id goes nowhere.
  relay.send(a.socketId, 'late')
  assert.deepEqual(sa.sent, ['hello'])
  off()
  sb.onopen({})
  assert.equal(events.length, 4)
})

test('browserRelay: a socket that cannot be made is a refusal, not a throw', async () => {
  const relay = browserRelay(() => 'bad', class {
    constructor() {
      throw new Error('SyntaxError: bad url')
    }
  })
  assert.deepEqual(await relay.open('web'), { ok: false, removed: false, reason: 'SyntaxError: bad url' })
})

test('the dialog queue: one at a time, in order, each answered by its own done', async () => {
  const first = webDialogs.confirm({ title: 'A', message: 'a?', confirmLabel: 'Yes' })
  const second = webDialogs.showError('B', 'b')
  const third = webDialogs.confirmWithCheckbox({ title: 'C', message: 'c?', confirmLabel: 'Go', checkboxLabel: 'also', checkboxChecked: true })
  const [d1, d2, d3] = pendingDialogs()
  assert.deepEqual([d1.kind, d2.kind, d3.kind], ['confirm', 'error', 'checkbox'])
  assert.ok(dialogId(d1) < dialogId(d2) && dialogId(d2) < dialogId(d3))
  answerDialog(d1, true)
  assert.equal(pendingDialogs()[0], d2)
  answerDialog(d2, true)
  answerDialog(d3, false, true)
  assert.deepEqual([await first, await second, await third], [true, undefined, { confirmed: false, checked: true }])
  assert.equal(pendingDialogs().length, 0)
})

test('the dialog queue: shiftDialog takes off the request it is given, not whichever is first', async () => {
  const a = webDialogs.confirm({ title: 'A', message: 'a?', confirmLabel: 'Yes' })
  webDialogs.confirm({ title: 'B', message: 'b?', confirmLabel: 'Yes' })
  const [d1, d2] = pendingDialogs()
  assert.equal(shiftDialog(d2), true)
  assert.deepEqual(pendingDialogs(), [d1])
  assert.equal(shiftDialog(d2), false, 'already off')
  assert.deepEqual(pendingDialogs(), [d1])
  // Answered twice (a click and an Escape in the same tick): the first answer stands.
  answerDialog(d1, true)
  answerDialog(d1, false)
  assert.equal(await a, true)
  assert.equal(pendingDialogs().length, 0)
})

test('the dialog queue: cancelDialogs (the shown project changed) answers every waiting one with its cancel', async () => {
  const confirm = webDialogs.confirm({ title: 'A', message: 'a?', confirmLabel: 'Delete' })
  const error = webDialogs.showError('B', 'b')
  const box = webDialogs.confirmWithCheckbox({ title: 'C', message: 'c?', confirmLabel: 'Go', checkboxLabel: 'also', checkboxChecked: true })
  const [, , d3] = pendingDialogs()
  cancelDialogs()
  assert.equal(pendingDialogs().length, 0)
  assert.deepEqual([await confirm, await error, await box], [false, undefined, { confirmed: false, checked: true }])
  // A late click on the gone dialog's button answers nothing more.
  answerDialog(d3, true, false)
  assert.equal(pendingDialogs().length, 0)
  cancelDialogs()
})

test('the dialog queue: cancelDialogById closes that confirm alone (a promote request settled elsewhere, 5e)', async () => {
  const other = webDialogs.confirm({ title: 'A', message: 'a?', confirmLabel: 'Delete' })
  const asked = webDialogs.confirmWithCheckbox({ title: 'P', message: 'p?', confirmLabel: 'Promote', checkboxLabel: 'stack', checkboxChecked: true, dialogId: 'promote:r1' })
  cancelDialogById('promote:r1')
  cancelDialogById('promote:none')
  assert.deepEqual(await asked, { confirmed: false, checked: true })
  assert.equal(pendingDialogs().length, 1)
  answerDialog(pendingDialogs()[0], true)
  assert.equal(await other, true)
})

test('the dialog queue: a cancel that arrives before its dialog is queued closes it as soon as it is (within 30 s), once', async () => {
  cancelDialogById('promote:early')
  assert.equal(await webDialogs.confirm({ title: 'P', message: 'p?', confirmLabel: 'Promote', dialogId: 'promote:early' }), false)
  assert.equal(pendingDialogs().length, 0)
  // Used up: the next one with that id shows.
  const again = webDialogs.confirm({ title: 'P', message: 'p?', confirmLabel: 'Promote', dialogId: 'promote:early' })
  assert.equal(pendingDialogs().length, 1)
  answerDialog(pendingDialogs()[0], true)
  assert.equal(await again, true)
  // Forgotten after 30 s.
  cancelDialogById('promote:old', Date.now() - 31_000)
  const later = webDialogs.confirmWithCheckbox({ title: 'P', message: 'p?', confirmLabel: 'Promote', checkboxLabel: 'stack', checkboxChecked: true, dialogId: 'promote:old' })
  assert.equal(pendingDialogs().length, 1)
  answerDialog(pendingDialogs()[0], false)
  assert.deepEqual(await later, { confirmed: false, checked: true })
})

/** A RegisteredServer-like source for the api's attention. */
function fakeConnection() {
  const statusListeners = new Set()
  const attentionListeners = new Set()
  const requests = []
  return {
    requests,
    publish: (entries) => attentionListeners.forEach((l) => l({ snapshot: { entries }, rev: 1 })),
    connection: {
      status: 'connected',
      on: (_kind, l) => {
        statusListeners.add(l)
        return () => statusListeners.delete(l)
      },
      request: async (method, params) => {
        requests.push([method, params])
        return null
      }
    },
    mirror: {
      subscribe: (_topic, l) => {
        attentionListeners.add(l)
        return () => attentionListeners.delete(l)
      }
    }
  }
}

const withWindow = async (fn) => {
  const store = new Map()
  globalThis.window = {
    location: { protocol: 'http:', host: '127.0.0.1:1' },
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v))
    }
  }
  try {
    await fn(store)
  } finally {
    delete globalThis.window
  }
}

test('the api: one entry, the page’s server, never editable; machine-only calls refused', async () => {
  await withWindow(async () => {
    const web = createWebApi(FakeSocket)
    const { api } = web
    const links = await api.appServers.links()
    assert.deepEqual(links.servers.map((s) => [s.id, s.name, s.url, s.hasToken, s.status]), [[WEB_ENTRY_ID, 'This server', '', true, null]])
    const heard = []
    api.appServers.onChanged((s) => heard.push(s.servers[0].name))
    const conn = fakeConnection()
    web.link(conn, () => 'box')
    assert.deepEqual(heard, ['box'])
    for (const call of [
      () => api.appServers.save({ name: 'x', url: 'ws://x' }),
      () => api.appServers.setToken(WEB_ENTRY_ID, 't'),
      () => api.appServers.remove(WEB_ENTRY_ID),
      () => api.openInVSCode('/x'),
      () => api.revealInFinder('/x'),
      () => api.localServer.start(),
      () => api.importTrekproj()
    ]) {
      await assert.rejects(call(), /Not available in the browser/)
    }
    assert.equal(await api.selectDirectory('pick'), null)
    assert.equal(await api.githubPrHeadBranch('a', 'b', 1), null)
    assert.deepEqual(await api.takeInitialWindowState(), { menu: null, server: null, select: null })
  })
})

test('the api: attention follows the page’s connection; open selects, dismiss asks the server', async () => {
  await withWindow(async () => {
    const web = createWebApi(FakeSocket)
    const opened = []
    web.hooks.openAttention = (item) => opened.push(item)
    const conn = fakeConnection()
    web.link(conn, () => 'box')
    const snapshots = []
    web.api.attention.onChanged((s) => snapshots.push(s))
    conn.publish([
      { projectId: 'p', projectName: 'P', worktreeId: 'w', sessionId: 's1', title: 'agent', status: 'attention', since: 5 },
      { projectId: 'p', projectName: 'P', worktreeId: 'w', sessionId: 's2', title: 'other', status: 'idle', since: 3, decision: { question: 'Go?', at: 4 } }
    ])
    const { items } = await web.api.attention.list()
    assert.deepEqual(items.map((i) => [i.sessionId, i.serverName, i.serverEntryId]), [['s1', 'box', WEB_ENTRY_ID], ['s2', 'box', WEB_ENTRY_ID]])
    assert.ok(snapshots.length >= 1)
    assert.equal(await web.api.attention.open(items[0].key), true)
    assert.deepEqual(opened.map((i) => i.sessionId), ['s1'])
    assert.equal(await web.api.attention.open('["web","p","gone"]'), false)
    await web.api.attention.dismiss(items[1].key)
    await web.api.attention.dismiss(items[0].key)
    assert.deepEqual(conn.requests, [
      ['session.dismissDecision', { projectId: 'p', sessionId: 's2' }],
      ['session.seen', { projectId: 'p', sessionId: 's1' }]
    ])
    await assert.rejects(web.api.attention.dismiss('["web","p","gone"]'), /no longer listed/)
  })
})

test('the api: app settings are this browser’s, kept in localStorage; a bad stored value is the defaults', async () => {
  await withWindow(async (store) => {
    store.set('trek.appSettings', 'not json')
    const web = createWebApi(FakeSocket)
    assert.equal((await web.api.appSettings.get()).voiceActive, true)
    const heard = []
    web.api.appSettings.onChanged((s) => heard.push(s.voiceActive))
    const saved = await web.api.appSettings.update({ voiceActive: false })
    assert.equal(saved.voiceActive, false)
    assert.deepEqual(heard, [false])
    assert.equal(JSON.parse(store.get('trek.appSettings')).voiceActive, false)
    // A new page reads it back.
    assert.equal((await createWebApi(FakeSocket).api.appSettings.get()).voiceActive, false)
  })
})

test('the api: confirm and showError go to the in-page queue', async () => {
  await withWindow(async () => {
    const { api } = createWebApi(FakeSocket)
    const answer = api.confirm({ title: 'T', message: 'm', confirmLabel: 'OK' })
    const [d] = pendingDialogs()
    assert.equal(d.title, 'T')
    answerDialog(d, true)
    assert.equal(await answer, true)
  })
})
