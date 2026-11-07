// scripts/v2SettingsWriter.test.mjs — a server window's settings edits: one compare-and-set per field at a time.
import test from 'node:test'
import assert from 'node:assert/strict'
import { commitStale, createSettingsWriter, sameSetting, textCommit } from '../src/renderer/src/v2/settingsWriter.ts'

class CodedError extends Error {
  constructor(code, message = code) {
    super(message)
    this.code = code
  }
}

const tick = () => new Promise((r) => setImmediate(r))

/**
 * A writer over a fake mirror holding `settings`. Each send is recorded and
 * stays open until the test settles it: `ok()` applies it to the mirror (as
 * its patch would), `fail(err)` rejects it.
 */
function setup({ settings = {}, choices = [] } = {}) {
  const mirror = { project: { id: 'p', name: 'P', settings: { ...settings }, repositories: [], globalSessions: [] } }
  const sends = []
  const log = []
  const field = (key) => ({
    key: `settings.${key}`,
    label: key,
    title: 'Could not save the setting',
    current: (project) => project.settings[key] ?? null,
    apply: (project, value) => {
      const next = { ...project.settings }
      if (value === null) delete next[key]
      else next[key] = value
      return { ...project, settings: next }
    },
    send: (value, expected) =>
      new Promise((resolve, reject) => {
        sends.push({
          key,
          value,
          expected,
          ok: () => {
            if (value === null) delete mirror.project.settings[key]
            else mirror.project.settings[key] = value
            resolve()
          },
          fail: reject
        })
      })
  })
  const writer = createSettingsWriter({
    project: () => mirror.project,
    changed: () => log.push('changed'),
    askConflict: async (label) => {
      log.push(`ask ${label}`)
      return choices.shift() ?? 'reload'
    },
    reload: () => log.push('reload'),
    reportEdit: (title, err) => log.push(`report ${title}: ${err.code}`)
  })
  const shown = (key) => writer.overlay(mirror.project).settings[key]
  return { writer, field, mirror, sends, log, shown }
}

test('sameSetting: null is absent, arrays compare in order', () => {
  assert.equal(sameSetting(undefined, null), true)
  assert.equal(sameSetting(['a', 'b'], ['a', 'b']), true)
  assert.equal(sameSetting(['a', 'b'], ['b', 'a']), false)
  assert.equal(sameSetting({ x: 1, y: undefined }, { x: 1 }), true)
})

test('an edit is sent with the value it started from, and shown until the server has it', async () => {
  const { writer, field, sends, shown, log } = setup({ settings: { audioAlerts: false } })
  writer.write(field('audioAlerts'), true)
  assert.deepEqual(sends.map(({ key, value, expected }) => [key, value, expected]), [['audioAlerts', true, false]])
  assert.equal(shown('audioAlerts'), true)
  sends[0].ok()
  await tick()
  assert.equal(shown('audioAlerts'), true)
  assert.deepEqual(log, ['changed', 'changed'])
})

test('an absent key is expected as null, and an edit to the value it has sends nothing', () => {
  const { writer, field, sends } = setup({ settings: { globalSystemPrompt: 'Be brief' } })
  writer.write(field('sessionTypes'), [{ id: 't', name: 'Review', systemPrompt: '' }])
  writer.write(field('globalSystemPrompt'), 'Be brief')
  assert.deepEqual(sends.map(({ key, expected }) => [key, expected]), [['sessionTypes', null]])
})

test('edits made while one is in flight: only the latest is sent next, expecting the value just written', async () => {
  const { writer, field, sends, shown } = setup({ settings: { titleBarColor: '#000000' } })
  writer.write(field('titleBarColor'), '#111111')
  writer.write(field('titleBarColor'), '#222222')
  writer.write(field('titleBarColor'), '#333333')
  assert.equal(sends.length, 1)
  assert.equal(shown('titleBarColor'), '#333333')
  sends[0].ok()
  await tick()
  assert.deepEqual(sends.map(({ value, expected }) => [value, expected]), [
    ['#111111', '#000000'],
    ['#333333', '#111111']
  ])
  sends[1].ok()
  await tick()
  assert.equal(sends.length, 2)
})

test('a later edit back to the value just written sends nothing more', async () => {
  const { writer, field, sends } = setup({ settings: { audioAlerts: false } })
  writer.write(field('audioAlerts'), true)
  writer.write(field('audioAlerts'), true)
  sends[0].ok()
  await tick()
  assert.equal(sends.length, 1)
})

test('fields are independent: one in flight does not hold up another', () => {
  const { writer, field, sends } = setup()
  writer.write(field('audioAlerts'), true)
  writer.write(field('logoImage'), 'data:image/png;base64,AA')
  assert.deepEqual(sends.map((s) => s.key), ['audioAlerts', 'logoImage'])
})

test('a CONFLICT whose field already holds what the user wanted needs no dialog', async () => {
  const { writer, field, sends, mirror, log } = setup({ settings: { audioAlerts: false } })
  writer.write(field('audioAlerts'), true)
  mirror.project.settings.audioAlerts = true
  sends[0].fail(new CodedError('CONFLICT'))
  await tick()
  assert.deepEqual(log, ['changed', 'changed'])
})

test('a real CONFLICT asks; Reload drops the edit and reloads the panel', async () => {
  const { writer, field, sends, mirror, log, shown } = setup({ settings: { sessionSystemPrompt: 'old' }, choices: ['reload'] })
  writer.write(field('sessionSystemPrompt'), 'mine')
  mirror.project.settings.sessionSystemPrompt = 'theirs'
  sends[0].fail(new CodedError('CONFLICT'))
  await tick()
  assert.equal(shown('sessionSystemPrompt'), 'theirs')
  assert.deepEqual(log, ['changed', 'changed', 'ask sessionSystemPrompt', 'reload'])
  assert.equal(sends.length, 1)
})

test('Keep Mine sends the latest edit again over the newer value', async () => {
  const { writer, field, sends, mirror, log } = setup({ settings: { sessionSystemPrompt: 'old' }, choices: ['keep'] })
  writer.write(field('sessionSystemPrompt'), 'mine')
  writer.write(field('sessionSystemPrompt'), 'mine, edited')
  mirror.project.settings.sessionSystemPrompt = 'theirs'
  sends[0].fail(new CodedError('CONFLICT'))
  await tick()
  assert.deepEqual(log.filter((l) => l.startsWith('ask')), ['ask sessionSystemPrompt'])
  assert.deepEqual(sends.map(({ value, expected }) => [value, expected]), [
    ['mine', 'old'],
    ['mine, edited', 'theirs']
  ])
})

test('an edit made while the conflict dialog is open wins over Keep Mine', async () => {
  let answer
  const { field, sends, mirror } = setup({ settings: { audioAlerts: false } })
  // Hold the dialog open until the test answers it.
  const held = createSettingsWriter({
    project: () => mirror.project,
    changed: () => {},
    askConflict: () => new Promise((r) => (answer = r)),
    reload: () => {},
    reportEdit: () => {}
  })
  held.write(field('audioAlerts'), true)
  mirror.project.settings.audioAlerts = null
  sends[0].fail(new CodedError('CONFLICT'))
  await tick()
  held.write(field('audioAlerts'), false)
  // That newer edit has already finished: Keep Mine still does not send over it.
  sends[1].ok()
  await tick()
  answer('keep')
  await tick()
  assert.deepEqual(sends.map(({ value, expected }) => [value, expected]), [
    [true, false],
    [false, null]
  ])
  assert.equal(mirror.project.settings.audioAlerts, false)
})

test('conflict dialogs come one at a time', async () => {
  let open = 0
  let most = 0
  const answers = []
  const { field, sends, mirror } = setup({ settings: { a: 1, b: 1 } })
  const writer = createSettingsWriter({
    project: () => mirror.project,
    changed: () => {},
    askConflict: () => {
      most = Math.max(most, ++open)
      return new Promise((r) => answers.push(() => (open--, r('reload'))))
    },
    reload: () => {},
    reportEdit: () => {}
  })
  writer.write(field('a'), 2)
  writer.write(field('b'), 2)
  mirror.project.settings.a = 3
  mirror.project.settings.b = 3
  sends[0].fail(new CodedError('CONFLICT'))
  sends[1].fail(new CodedError('CONFLICT'))
  await tick()
  assert.equal(answers.length, 1)
  answers[0]()
  await tick()
  assert.equal(answers.length, 2)
  answers[1]()
  await tick()
  assert.equal(most, 1)
})

test('any other failure is reported as an edit, and the queued edit goes with it', async () => {
  const { writer, field, sends, log, shown } = setup({ settings: { audioAlerts: false } })
  writer.write(field('audioAlerts'), true)
  writer.write(field('audioAlerts'), false)
  sends[0].fail(new CodedError('NOT_CONNECTED'))
  await tick()
  assert.equal(shown('audioAlerts'), false)
  assert.equal(log.at(-1), 'report Could not save the setting: NOT_CONNECTED')
  assert.equal(sends.length, 1)
})

test('after clear, answers in flight change nothing', async () => {
  const { writer, field, sends, log, mirror } = setup({ settings: { audioAlerts: false } })
  writer.write(field('audioAlerts'), true)
  writer.write(field('audioAlerts'), false)
  writer.clear()
  assert.equal(writer.overlay(mirror.project).settings.audioAlerts, false)
  sends[0].fail(new CodedError('CONFLICT'))
  await tick()
  assert.deepEqual(log, ['changed', 'changed'])
  assert.equal(sends.length, 1)
})

/** A writer over `setup`'s mirror whose conflict dialog stays open until `answer(choice)`. */
function heldWriter(ctx) {
  const asks = []
  const log = []
  const writer = createSettingsWriter({
    project: () => ctx.mirror.project,
    changed: () => {},
    askConflict: (label) => new Promise((r) => asks.push({ label, answer: r })),
    reload: () => log.push('reload'),
    reportEdit: (title, err) => log.push(`report ${err.code}`)
  })
  return { writer, asks, log }
}

test('a CONFLICT on the queued second send: it carried the first value as expected, and asks', async () => {
  const ctx = setup({ settings: { titleBarColor: '#000000' }, choices: ['keep'] })
  const { writer, field, sends, mirror, log } = ctx
  writer.write(field('titleBarColor'), '#111111')
  writer.write(field('titleBarColor'), '#222222')
  sends[0].ok()
  await tick()
  assert.deepEqual([sends[1].value, sends[1].expected], ['#222222', '#111111'])
  mirror.project.settings.titleBarColor = '#999999'
  sends[1].fail(new CodedError('CONFLICT'))
  await tick()
  assert.deepEqual(log.filter((l) => l.startsWith('ask')), ['ask titleBarColor'])
  assert.deepEqual([sends[2].value, sends[2].expected], ['#222222', '#999999'])
})

test('a write with no project (no snapshot, or the window left) sends nothing and shows nothing', () => {
  const { writer, field, sends, mirror, log } = setup({ settings: { audioAlerts: false } })
  const project = mirror.project
  mirror.project = undefined
  writer.write(field('audioAlerts'), true)
  writer.write(field('logoImage'), 'x', { stale: true })
  assert.equal(sends.length, 0)
  assert.deepEqual(log, [])
  assert.equal(writer.overlay(project).settings.audioAlerts, false)
})

test('textCommit: a draft over a value changed meanwhile is stale; an unchanged draft lets the newer value stand', () => {
  assert.equal(textCommit('a', 'a', 'a'), 'none')
  assert.equal(textCommit('a', 'a', 'mine'), 'write')
  assert.equal(textCommit('a', 'theirs', 'mine'), 'stale')
  assert.equal(textCommit('a', 'theirs', 'a'), 'none', 'not edited: the newer value stands')
  assert.equal(textCommit('a', 'same', 'same'), 'none', 'already what the user typed')
})

test('a stale draft is not sent: it asks, and Reload drops it', async () => {
  const ctx = setup({ settings: { sessionSystemPrompt: 'theirs' }, choices: ['reload'] })
  const { writer, field, sends, log, shown } = ctx
  commitStale(() => writer.write(field('sessionSystemPrompt'), 'mine'))
  await tick()
  assert.equal(sends.length, 0)
  assert.deepEqual(log, ['ask sessionSystemPrompt', 'reload'])
  assert.equal(shown('sessionSystemPrompt'), 'theirs')
  // Outside commitStale, a write is an ordinary one again.
  writer.write(field('sessionSystemPrompt'), 'later')
  assert.deepEqual([sends[0].value, sends[0].expected], ['later', 'theirs'])
})

test('a stale draft: Keep Mine sends it over the newer value', async () => {
  const { writer, field, sends, log } = setup({ settings: { sessionSystemPrompt: 'theirs' }, choices: ['keep'] })
  writer.write(field('sessionSystemPrompt'), 'mine', { stale: true })
  await tick()
  assert.deepEqual(log.filter((l) => l.startsWith('ask')), ['ask sessionSystemPrompt'])
  assert.deepEqual(sends.map(({ value, expected }) => [value, expected]), [['mine', 'theirs']])
})

test('a stale draft that is already the server value asks nothing', async () => {
  const { writer, field, sends, log } = setup({ settings: { sessionSystemPrompt: 'same' } })
  writer.write(field('sessionSystemPrompt'), 'same', { stale: true })
  await tick()
  assert.deepEqual([sends.length, log], [0, []])
})

test('a stale draft: Keep Mine waits behind an edit of the field still in flight', async () => {
  const ctx = setup({ settings: { a: 1 } })
  const { writer, asks } = heldWriter(ctx)
  const { field, sends } = ctx
  writer.write(field('a'), 2)
  ctx.mirror.project.settings.a = 5
  writer.write(field('a'), 3, { stale: true })
  await tick()
  asks[0].answer('keep')
  await tick()
  assert.equal(sends.length, 1)
  sends[0].ok()
  await tick()
  assert.deepEqual(sends.map(({ value, expected }) => [value, expected]), [
    [2, 1],
    [3, 2]
  ])
})

test('a stale draft: Keep Mine is skipped when the field was written again, even if that edit already finished', async () => {
  const ctx = setup({ settings: { a: 1 } })
  const { writer, asks } = heldWriter(ctx)
  const { field, sends } = ctx
  writer.write(field('a'), 2, { stale: true })
  await tick()
  writer.write(field('a'), 4)
  sends[0].ok()
  await tick()
  asks[0].answer('keep')
  await tick()
  assert.deepEqual(sends.map(({ value, expected }) => [value, expected]), [[4, 1]])
})
