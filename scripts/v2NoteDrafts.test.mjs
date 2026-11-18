// scripts/v2NoteDrafts.test.mjs — a server window's notes drafts, kept per branch until the server has them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createNoteDrafts } from '../src/renderer/src/v2/noteDrafts.ts'

const coded = (code, message = code) => Object.assign(new Error(message), { code })
const tick = () => new Promise((r) => setImmediate(r))

/**
 * Drafts over fakes: `notes` is the mirror ('repo\nbranch' → note), `sent`
 * each setNote, `answers` how each one ends (an Error, or a function that
 * settles it later), `shown` and `always` the two kinds of dialog.
 */
function setup({ offline = false, answers = [] } = {}) {
  const notes = {}
  const sent = []
  const shown = []
  const always = []
  const flags = { offline }
  const drafts = createNoteDrafts({
    setNote: async (repoId, branch, text, expected) => {
      sent.push([branch, text, expected])
      const answer = answers.shift()
      if (answer instanceof Error) throw answer
      if (typeof answer === 'function') await new Promise((resolve, reject) => answer(resolve, reject))
      notes[`${repoId}\n${branch}`] = text
    },
    saved: (repoId, branch) => notes[`${repoId}\n${branch}`] ?? '',
    offline: () => flags.offline,
    show: (title, message) => shown.push([title, message]),
    showAlways: (title, message) => always.push([title, message])
  })
  return { drafts, notes, sent, shown, always, flags }
}

test('a save sends the text with its base, and the draft settles once the mirror has it', async () => {
  const { drafts, notes, sent } = setup()
  notes['r\nfeat'] = 'old'
  drafts.edit('r', 'feat', 'new')
  assert.deepEqual(drafts.get('r', 'feat'), { text: 'new', base: 'old' })
  drafts.save('r', 'feat')
  await tick()
  assert.deepEqual(sent, [['feat', 'new', 'old']])
  assert.equal(drafts.get('r', 'feat'), null)
})

test('a draft outlives its panel: switching branches keeps it, and its save goes on', async () => {
  let release
  const { drafts, sent } = setup({ answers: [(r) => (release = r)] })
  drafts.edit('r', 'feat', 'typed')
  drafts.save('r', 'feat')
  drafts.edit('r', 'main', 'other')
  assert.deepEqual(drafts.get('r', 'feat'), { text: 'typed', base: '' })
  release()
  await tick()
  assert.equal(drafts.get('r', 'feat'), null)
  assert.deepEqual(drafts.get('r', 'main'), { text: 'other', base: '' })
  assert.deepEqual(sent, [['feat', 'typed', '']])
})

test('listeners hear every change', async () => {
  const { drafts } = setup()
  let heard = 0
  const off = drafts.subscribe(() => heard++)
  drafts.edit('r', 'feat', 'a')
  drafts.save('r', 'feat')
  await tick()
  off()
  drafts.edit('r', 'feat', 'b')
  assert.equal(heard, 2)
})

test('offline: nothing is sent; once the link is back, saveAll sends every kept draft', async () => {
  const { drafts, sent, flags } = setup({ offline: true })
  drafts.edit('r', 'feat', 'one')
  drafts.edit('r', 'main', 'two')
  drafts.save('r', 'feat')
  assert.deepEqual(sent, [])
  flags.offline = false
  drafts.saveAll()
  await tick()
  assert.deepEqual(sent, [['feat', 'one', ''], ['main', 'two', '']])
  assert.equal(drafts.get('r', 'feat'), null)
})

test('a save asked for while one is in flight runs after it, expecting the base it moved to', async () => {
  let release
  const { drafts, sent } = setup({ answers: [(r) => (release = r)] })
  drafts.edit('r', 'feat', 'a')
  drafts.save('r', 'feat')
  drafts.edit('r', 'feat', 'ab')
  drafts.save('r', 'feat')
  assert.equal(sent.length, 1)
  release()
  await tick()
  await tick()
  assert.deepEqual(sent, [['feat', 'a', ''], ['feat', 'ab', 'a']])
})

test('a refusal keeps the draft and says so; a conflict drops it and shows the text', async () => {
  const { drafts, shown } = setup({ answers: [coded('TIMEOUT', 'setNote timed out'), coded('CONFLICT')] })
  drafts.edit('r', 'feat', 'mine')
  drafts.save('r', 'feat')
  await tick()
  assert.deepEqual(drafts.get('r', 'feat'), { text: 'mine', base: '' })
  drafts.save('r', 'feat')
  await tick()
  assert.equal(drafts.get('r', 'feat'), null)
  assert.deepEqual(shown.map(([title]) => title), ['Could not save the note', 'The note was changed elsewhere'])
})

test('a NOT_FOUND refusal drops the draft and shows its text once: a reconnect sends nothing again', async () => {
  const { drafts, sent, shown, flags } = setup({ answers: [coded('NOT_FOUND', 'no such branch')] })
  drafts.edit('r', 'gone', 'mine')
  drafts.save('r', 'gone')
  await tick()
  assert.equal(drafts.get('r', 'gone'), null)
  assert.deepEqual(shown, [['Could not save the note', 'no such branch\n\nYour text was:\n\nmine']])
  flags.offline = true
  flags.offline = false
  drafts.saveAll()
  await tick()
  assert.equal(sent.length, 1)
  assert.equal(shown.length, 1)
})

test('leave: an unsaved draft is sent at once; one that fails shows its text even after the window left', async () => {
  const { drafts, sent, shown, always } = setup({ answers: [coded('NOT_CONNECTED')] })
  drafts.edit('r', 'feat', 'last words')
  drafts.leave()
  assert.deepEqual(sent, [['feat', 'last words', '']])
  await tick()
  assert.deepEqual(shown, [])
  assert.equal(always.length, 1)
  assert.equal(always[0][0], 'Your note was not saved')
  assert.match(always[0][1], /feat[\s\S]*last words/)
})

test('leave while offline shows each unsaved draft without sending; a saved one shows nothing', async () => {
  const { drafts, sent, always, flags } = setup()
  drafts.edit('r', 'done', 'saved already')
  drafts.save('r', 'done')
  await tick()
  flags.offline = true
  drafts.edit('r', 'feat', 'typed offline')
  drafts.leave()
  assert.deepEqual(sent, [['done', 'saved already', '']])
  assert.equal(always.length, 1)
  assert.match(always[0][1], /typed offline/)
})

test('leave with a save in flight: a failure after the window left shows the text once; a success shows nothing', async () => {
  let fail
  const failing = setup({ answers: [(_resolve, reject) => (fail = reject)] })
  failing.drafts.edit('r', 'feat', 'busy')
  failing.drafts.save('r', 'feat')
  failing.drafts.leave()
  assert.equal(failing.sent.length, 1)
  fail(coded('NOT_CONNECTED'))
  await tick()
  await tick()
  assert.equal(failing.always.length, 1)
  assert.match(failing.always[0][1], /busy/)
  assert.equal(failing.drafts.get('r', 'feat'), null)

  let release
  const passing = setup({ answers: [(resolve) => (release = resolve)] })
  passing.drafts.edit('r', 'feat', 'busy')
  passing.drafts.save('r', 'feat')
  passing.drafts.leave()
  release()
  await tick()
  await tick()
  assert.deepEqual([passing.sent.length, passing.always], [1, []])
})

test('typed and taken back: the draft goes, listeners hear it, and a change made elsewhere shows', async () => {
  const { drafts, notes, sent } = setup()
  notes['r\nfeat'] = 'old'
  let heard = 0
  drafts.subscribe(() => heard++)
  drafts.edit('r', 'feat', 'oldq')
  assert.deepEqual(drafts.get('r', 'feat'), { text: 'oldq', base: 'old' })
  drafts.edit('r', 'feat', 'old')
  assert.equal(drafts.get('r', 'feat'), null)
  assert.equal(heard, 2)
  // Nothing is held for the branch: neither a save nor the link coming back sends anything.
  drafts.save('r', 'feat')
  drafts.saveAll()
  await tick()
  assert.deepEqual(sent, [])
  // The next edit starts from the note as it is by then, not from the one the dropped draft knew.
  notes['r\nfeat'] = 'theirs'
  drafts.edit('r', 'feat', 'theirs!')
  assert.deepEqual(drafts.get('r', 'feat'), { text: 'theirs!', base: 'theirs' })
})

test('an edit that changes nothing starts no draft and tells no one', () => {
  const { drafts, notes } = setup()
  notes['r\nfeat'] = 'old'
  let heard = 0
  drafts.subscribe(() => heard++)
  drafts.edit('r', 'feat', 'old')
  assert.equal(drafts.get('r', 'feat'), null)
  assert.equal(heard, 0)
})

test('taken back while a save is out: the draft waits for the save, then sends the text it was taken back to', async () => {
  let release
  const { drafts, sent } = setup({ answers: [(r) => (release = r)] })
  drafts.edit('r', 'feat', 'a')
  drafts.save('r', 'feat')
  drafts.edit('r', 'feat', '')
  // Equal to its base, but the save out is about to move that base to 'a'.
  assert.deepEqual(drafts.get('r', 'feat'), { text: '', base: '' })
  release()
  await tick()
  assert.deepEqual(drafts.get('r', 'feat'), { text: '', base: 'a' })
  drafts.save('r', 'feat')
  await tick()
  assert.deepEqual(sent, [['feat', 'a', ''], ['feat', '', 'a']])
  assert.equal(drafts.get('r', 'feat'), null)
})

test('typed on and taken back to the text a save is sending: the draft is gone once that save returns', async () => {
  let release
  const { drafts, sent } = setup({ answers: [(r) => (release = r)] })
  drafts.edit('r', 'feat', 'a')
  drafts.save('r', 'feat')
  drafts.edit('r', 'feat', 'ab')
  drafts.edit('r', 'feat', 'a')
  assert.deepEqual(drafts.get('r', 'feat'), { text: 'a', base: '' })
  let heard = 0
  drafts.subscribe(() => heard++)
  release()
  await tick()
  assert.equal(drafts.get('r', 'feat'), null)
  assert.equal(heard, 1)
  assert.deepEqual(sent, [['feat', 'a', '']])
})

test('a save answered after the note moved on elsewhere leaves no draft to hide that change', async () => {
  let release
  const { drafts, notes } = setup({ answers: [(r) => (release = r)] })
  drafts.edit('r', 'feat', 'mine')
  drafts.save('r', 'feat')
  release()
  // The fake mirror takes the save, and then the other change, before the save's answer is handled.
  await Promise.resolve()
  notes['r\nfeat'] = 'theirs'
  await tick()
  assert.equal(notes['r\nfeat'], 'theirs')
  assert.equal(drafts.get('r', 'feat'), null)
})

test('a failed save whose text was taken back meanwhile leaves no draft: nothing is left to send', async () => {
  let fail
  const { drafts, notes, sent, shown } = setup({ answers: [(_resolve, reject) => (fail = reject)] })
  notes['r\nfeat'] = 'old'
  drafts.edit('r', 'feat', 'new')
  drafts.save('r', 'feat')
  drafts.edit('r', 'feat', 'old')
  assert.deepEqual(drafts.get('r', 'feat'), { text: 'old', base: 'old' })
  fail(coded('TIMEOUT', 'setNote timed out'))
  await tick()
  await tick()
  assert.equal(drafts.get('r', 'feat'), null)
  // The save did fail, and says so.
  assert.deepEqual(shown, [['Could not save the note', 'setNote timed out']])
  drafts.saveAll()
  await tick()
  assert.equal(sent.length, 1)
})
