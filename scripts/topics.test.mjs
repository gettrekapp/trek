// scripts/topics.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTopic, projectTopic } from '../src/shared/model/topics.ts'

test('fixed topics parse', () => {
  assert.deepEqual(parseTopic('server'), { kind: 'server' })
  assert.deepEqual(parseTopic('attention'), { kind: 'attention' })
})

test('project topics round-trip', () => {
  assert.equal(projectTopic('p1'), 'project:p1')
  assert.deepEqual(parseTopic(projectTopic('p1')), { kind: 'project', projectId: 'p1' })
})

test('anything else is not a topic', () => {
  for (const t of ['', 'project:', 'projects:p1', 'Server', 'project', 5, null]) {
    assert.equal(parseTopic(t), null, String(t))
  }
})
