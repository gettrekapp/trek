// scripts/serverStatus.test.mjs — the desktop's status rules, ported; input filter; attention entries.
import test from 'node:test'
import assert from 'node:assert/strict'
import { attentionEntries, isQueryReply, isTerminalReply, newActivity, onBell, onInput, onOutput, onQuiet } from '../server/src/sessions/status.ts'

const markers = ['esc to interrupt']

test('output makes a session working and asks for the quiet timer', () => {
  for (const status of ['idle', 'done', 'working']) {
    const r = onOutput(status, newActivity(), 'hello', markers)
    assert.equal(r.status, 'working', status)
    assert.equal(r.restartTimer, true)
  }
})

test('output leaves attention and exited alone, and is ignored while complete', () => {
  assert.equal(onOutput('attention', newActivity(), 'x', markers).status, 'attention')
  assert.equal(onOutput('exited', newActivity(), 'x', markers).status, 'exited')
  const complete = onOutput('complete', newActivity(), 'esc to interrupt', markers)
  assert.equal(complete.status, 'complete')
  assert.equal(complete.restartTimer, false)
  assert.equal(complete.activity.processingSeen, false)
})

test('markers are found case-insensitively, even split across chunks', () => {
  let a = onOutput('idle', newActivity(), '… Esc to inte', markers).activity
  assert.equal(a.processingSeen, false)
  a = onOutput('working', a, 'rrupt)', markers).activity
  assert.equal(a.processingSeen, true)
})

test('quiet: done after real work, idle after a repaint; only while working', () => {
  assert.deepEqual(onQuiet('working', { processingSeen: true, scanTail: 'x' }), { status: 'done', activity: { processingSeen: false, scanTail: 'x' } })
  assert.equal(onQuiet('working', { processingSeen: false, scanTail: '' }).status, 'idle')
  assert.equal(onQuiet('attention', { processingSeen: true, scanTail: '' }).status, 'attention')
  assert.equal(onQuiet('attention', { processingSeen: true, scanTail: '' }).activity.processingSeen, true)
})

test('bell means attention unless complete; input clears attention and complete', () => {
  for (const s of ['idle', 'working', 'done', 'attention']) assert.equal(onBell(s), 'attention')
  assert.equal(onBell('complete'), 'complete')
  assert.equal(onBell('exited'), 'exited')
  assert.equal(onInput('attention'), 'working')
  assert.equal(onInput('complete'), 'working')
  for (const s of ['idle', 'working', 'done', 'exited']) assert.equal(onInput(s), s)
})

test('terminal replies are not user input', () => {
  for (const reply of ['\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[I', '\x1b[O',
    '\x1b]11;rgb:0d0d/0d0d/0f0f\x07', '\x1b]10;rgb:c9c9/c9c9/cfcf\x1b\\', '\x1b[I\x1b[12;1R',
    '\x1b[?12;40R', '\x1b[?2026;2$y', '\x1b[4;1$y', '\x1bP1$r0m\x1b\\', '\x1bP0$r\x1b\\', '\x1b[8;24;80t',
    '\x1b[<35;10;5M', '\x1b[<0;10;5m', '\x1b[M #!']) {
    assert.equal(isTerminalReply(reply), true, JSON.stringify(reply))
  }
  for (const input of ['a', '\r', '\x1b[A', '\x03', 'hello\r', '\x1b[200~paste\x1b[201~', '', '\x1b[I a', '\x1ba', '\x1bOR', '\x1b[15~']) {
    assert.equal(isTerminalReply(input), input === '' ? true : false, JSON.stringify(input))
  }
})

test('query replies: only answers to a query (and focus), never mouse reports or typing', () => {
  for (const reply of ['\x1b[12;40R', '\x1b[?12;40R', '\x1b[?1;2c', '\x1b[?62;22c', '\x1b[>0;276;0c', '\x1b[0n',
    '\x1b[?2026;2$y', '\x1b[4;1$y', '\x1b]11;rgb:0d0d/0d0d/0f0f\x07', '\x1b]10;rgb:c9c9/c9c9/cfcf\x1b\\',
    '\x1b[I', '\x1b[O', '\x1b[I\x1b[12;1R', '\x1bP1$r0m\x1b\\', '\x1b[8;24;80t']) {
    assert.equal(isQueryReply(reply), true, JSON.stringify(reply))
  }
  for (const input of ['', 'a', '\r', '\x1b[A', '\x03', '\x1b[<35;10;5M', '\x1b[<0;10;5m', '\x1b[M #!', '\x1b[12;40Rx',
    'x\x1b[0n', '\x1b[200~paste\x1b[201~', '\x1b[15~']) {
    assert.equal(isQueryReply(input), false, JSON.stringify(input))
  }
})

test('attentionEntries lists attention and done sessions, oldest first, with Global as null', () => {
  const s = (id, status, title = id) => ({ id, title, llm: { provider: 'claude' }, queue: [], status })
  const projects = [{
    id: 'p', name: 'P', settings: {},
    globalSessions: [s('g', 'done')],
    repositories: [{ id: 'r', name: 'R', path: '/r', branchData: {}, worktrees: [
      { id: 'w', name: 'w', path: '/r', isMain: true, loaded: true, sessions: [s('a', 'attention', 'Fix'), s('b', 'working'), s('c', 'idle')] }
    ] }]
  }]
  const since = new Map([['a', 200], ['g', 100]])
  assert.deepEqual(attentionEntries(projects, since, () => 999), [
    { projectId: 'p', worktreeId: null, sessionId: 'g', title: 'g', status: 'done', since: 100, projectName: 'P' },
    { projectId: 'p', worktreeId: 'w', sessionId: 'a', title: 'Fix', status: 'attention', since: 200, projectName: 'P' }
  ])
  assert.equal(attentionEntries(projects, new Map(), () => 999)[0].since, 999)
})

test('attentionEntries keeps the since it falls back to, so the next publish has the same one', () => {
  const projects = [{
    id: 'p', name: 'P', settings: {},
    globalSessions: [{ id: 'g', title: 'g', llm: { provider: 'claude' }, queue: [], status: 'done' }],
    repositories: []
  }]
  const since = new Map()
  let clock = 500
  assert.equal(attentionEntries(projects, since, () => clock)[0].since, 500)
  assert.equal(since.get('g'), 500)
  clock = 900
  assert.equal(attentionEntries(projects, since, () => clock)[0].since, 500)
})

test('attentionEntries also lists a session with an open decision, in any status, since it was asked', () => {
  const s = (id, status, decision) => ({ id, title: id, llm: { provider: 'claude' }, queue: [], status, ...(decision ? { decision } : {}) })
  const projects = [{
    id: 'p', name: 'P', settings: {}, globalSessions: [],
    repositories: [{ id: 'r', name: 'R', path: '/r', branchData: {}, worktrees: [
      { id: 'w', name: 'w', path: '/r', isMain: true, loaded: true, sessions: [
        s('a', 'working', { question: 'Which DB?', at: 300 }),
        s('b', 'attention', { question: 'Merge?', at: 500 }),
        s('c', 'idle')
      ] }
    ] }]
  }]
  assert.deepEqual(attentionEntries(projects, new Map([['b', 100]]), () => 999), [
    { projectId: 'p', worktreeId: 'w', sessionId: 'b', title: 'b', status: 'attention', since: 100, projectName: 'P', decision: { question: 'Merge?', at: 500 } },
    { projectId: 'p', worktreeId: 'w', sessionId: 'a', title: 'a', status: 'working', since: 300, projectName: 'P', decision: { question: 'Which DB?', at: 300 } }
  ])
})

test("attentionEntries carries each project's name, and audioAlerts only when it is on", () => {
  const s = (id) => ({ id, title: id, llm: { provider: 'claude' }, queue: [], status: 'attention' })
  const project = (id, name, settings) => ({ id, name, settings, globalSessions: [s(`${id}-g`)], repositories: [] })
  const projects = [project('p', 'Loud', { audioAlerts: true }), project('q', 'Quiet', { audioAlerts: false }), project('r', 'Unset', {})]
  const since = new Map([['p-g', 1], ['q-g', 2], ['r-g', 3]])
  assert.deepEqual(attentionEntries(projects, since, () => 9).map((e) => [e.projectName, e.audioAlerts]), [
    ['Loud', true],
    ['Quiet', undefined],
    ['Unset', undefined]
  ])
  assert.equal(Object.hasOwn(attentionEntries(projects, since, () => 9)[1], 'audioAlerts'), false)
})
