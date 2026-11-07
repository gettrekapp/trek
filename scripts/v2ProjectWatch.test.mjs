// scripts/v2ProjectWatch.test.mjs — how a server window learns its project was deleted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { projectGone, watchesServerTopic } from '../src/renderer/src/v2/projectWatch.ts'

const coded = (code) => Object.assign(new Error(code), { code })

test('NOT_FOUND and TOPIC_ENDED mean the project is gone; anything else is transient', () => {
  assert.equal(projectGone(coded('NOT_FOUND')), true)
  assert.equal(projectGone(coded('TOPIC_ENDED')), true)
  for (const code of ['TIMEOUT', 'INTERNAL', 'CLOSED', 'NOT_CONNECTED']) assert.equal(projectGone(coded(code)), false, code)
})

test('only a server without topicEnd needs the server topic watched', () => {
  assert.equal(watchesServerTopic(['mcp', 'topicEnd']), false)
  assert.equal(watchesServerTopic(['mcp']), true)
  assert.equal(watchesServerTopic([]), true)
})
