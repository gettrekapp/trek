import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendEvent, appendJournal, buildContext, createBotFolder, defaultBotFolder, emptyState,
  loadState, localDate, readConfig, readEvents, readPolicy, saveState
} from '../src/host/bot/memory.ts'

const folder = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'bot-mem-')), 'My.trekbot')
  createBotFolder(dir)
  return dir
}
const NOW = new Date(2026, 10, 2, 9, 30).getTime()

test('default folder sits next to the project file', () => {
  assert.equal(defaultBotFolder('/p/My.trekproj'), '/p/My.trekbot')
})

test('creates starter files', () => {
  const dir = folder()
  for (const f of ['BOT.md', 'HEARTBEAT.md', 'POLICY.json', 'config.json', 'MEMORY.md', 'knowledge', 'journal', 'state']) {
    assert.ok(existsSync(join(dir, f)), f)
  }
  const bot = readFileSync(join(dir, 'BOT.md'), 'utf8')
  assert.match(bot, /secrets/i)
  assert.match(bot, /as data/i)
  assert.match(bot, /delegate/i)
})

test('creating again keeps existing files', () => {
  const dir = folder()
  writeFileSync(join(dir, 'BOT.md'), 'mine')
  createBotFolder(dir)
  assert.equal(readFileSync(join(dir, 'BOT.md'), 'utf8'), 'mine')
})

test('config has defaults and clamps bad values', () => {
  const dir = folder()
  assert.deepEqual(readConfig(dir), { intervalMinutes: 5, turnTimeoutMinutes: 15, dailyTurnCap: 100 })
  writeFileSync(join(dir, 'config.json'), '{"intervalMinutes":0,"dailyTurnCap":7}')
  assert.deepEqual(readConfig(dir), { intervalMinutes: 1, turnTimeoutMinutes: 15, dailyTurnCap: 7 })
  writeFileSync(join(dir, 'config.json'), 'nope')
  assert.equal(readConfig(dir).intervalMinutes, 5)
})

test('an unreadable policy file means no overrides', () => {
  const dir = folder()
  writeFileSync(join(dir, 'POLICY.json'), 'nope')
  assert.deepEqual(readPolicy(dir), {})
})

test('state round-trips and starts empty', () => {
  const dir = folder()
  assert.deepEqual(loadState(dir), emptyState())
  const state = { ...emptyState(), paused: true, queue: [{ kind: 'chat', text: 'hi' }] }
  saveState(dir, state)
  assert.deepEqual(loadState(dir), state)
})

test('events keep the newest entries', () => {
  const dir = folder()
  for (let i = 0; i < 5; i++) appendEvent(dir, { at: i, kind: 'text', text: String(i) })
  assert.deepEqual(readEvents(dir, 2).map((e) => e.text), ['3', '4'])
})

test('journal appends to the local day file', () => {
  const dir = folder()
  appendJournal(dir, NOW, 'did a thing')
  appendJournal(dir, NOW, 'another')
  const text = readFileSync(join(dir, 'journal', `${localDate(NOW)}.md`), 'utf8')
  assert.match(text, /did a thing[\s\S]*another/)
  assert.equal(localDate(NOW), '2026-11-02')
})

test('context carries rules, memory, journal tail and the wake', () => {
  const dir = folder()
  writeFileSync(join(dir, 'BOT.md'), 'RULES')
  writeFileSync(join(dir, 'MEMORY.md'), 'REMEMBERED')
  appendJournal(dir, NOW, 'x'.repeat(5000))
  appendJournal(dir, NOW, 'LATEST')
  const { systemPrompt, prompt } = buildContext(dir, { kind: 'chat', text: 'hello' }, NOW)
  assert.match(systemPrompt, /RULES/)
  assert.match(systemPrompt, /REMEMBERED/)
  assert.match(prompt, /LATEST/)
  assert.match(prompt, /hello/)
  assert.ok(prompt.length < 4600)
})

test('oversized memory is truncated with a note', () => {
  const dir = folder()
  writeFileSync(join(dir, 'MEMORY.md'), 'y'.repeat(9000))
  const { systemPrompt } = buildContext(dir, { kind: 'heartbeat', text: 'x' }, NOW)
  assert.match(systemPrompt, /over its 8 KB cap/)
  assert.ok(systemPrompt.length < 10_000)
})

test('reflection asks the bot to distil its journal', () => {
  const dir = folder()
  assert.match(buildContext(dir, { kind: 'reflection', text: '' }, NOW).prompt, /journal.*knowledge/s)
})
