// scripts/serverProjectState.test.mjs — in-memory projects: apply, topics, persistence, summaries.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { applyStatePatch } from '../src/shared/sync/topicState.ts'

function setup(initial = []) {
  const hub = new TopicHub()
  const saved = []
  const removed = []
  const store = { save: (p) => saved.push(structuredClone(p)), remove: (id) => removed.push(id) }
  let n = 0
  let summaries = 0
  const state = new ProjectState({ hub, store, newId: () => `id${++n}`, onSummariesChange: () => summaries++ }, initial)
  const registered = { id: 'a', name: 'A', path: '/r/a' }
  return { hub, saved, removed, state, registered, summaries: () => summaries }
}

const sub = () => {
  const sent = []
  return { sent, send: (topic, rev, ops) => sent.push({ topic, rev, ops }) }
}

test('create publishes the topic, saves, and updates summaries', () => {
  const { hub, saved, state, registered, summaries } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  assert.equal(id, 'id1')
  assert.deepEqual(state.list(), [{ id: 'id1', name: 'P' }])
  assert.equal(hub.subscribe(`project:${id}`, sub()).snapshot.name, 'P')
  assert.equal(saved.length, 1)
  assert.equal(summaries(), 1)
})

test('apply mutates a draft, publishes one patch and saves; a no-op does nothing', () => {
  const { hub, saved, state, registered } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  const s = sub()
  let mirror = hub.subscribe(`project:${id}`, s)
  state.apply(id, (d) => { d.repositories[0].branchData.main = { note: 'hi' } })
  state.apply(id, () => {})
  assert.equal(s.sent.length, 1)
  mirror = applyStatePatch(mirror, s.sent[0]).state
  assert.deepEqual(mirror.snapshot.repositories[0].branchData, { main: { note: 'hi' } })
  assert.equal(saved.length, 2)
})

test('a throwing mutation leaves the project unchanged', () => {
  const { state, registered } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  assert.throws(() => state.apply(id, (d) => { d.name = 'X'; throw new Error('no') }))
  assert.equal(state.require(id).name, 'P')
})

test('renaming through apply updates summaries; unknown ids are NOT_FOUND', () => {
  const { state, registered, summaries } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  state.apply(id, (d) => { d.name = 'Q' })
  assert.equal(summaries(), 2)
  assert.deepEqual(state.list(), [{ id, name: 'Q' }])
  assert.throws(() => state.apply('nope', () => {}), (err) => err.code === 'NOT_FOUND')
})

test('delete drops the topic and removes the file', () => {
  const { hub, removed, state, registered } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  state.delete(id)
  assert.deepEqual(state.list(), [])
  assert.equal(hub.subscribe(`project:${id}`, sub()), undefined)
  assert.deepEqual(removed, [id])
})

test('initial projects are published; usage and ids span all projects', () => {
  const project = { id: 'p1', name: 'One', settings: {}, globalSessions: [], repositories: [
    { id: 'r1', name: 'r', path: '/r/a', branchData: {}, worktrees: [{ id: 'w1', name: 'w', path: '/r/a', isMain: true, loaded: false, sessions: [] }] }
  ] }
  const { hub, state } = setup([project])
  assert.equal(hub.subscribe('project:p1', sub()).snapshot.name, 'One')
  assert.deepEqual(state.usage('/r/a'), ['One'])
  assert.deepEqual([...state.allIds()].sort(), ['p1', 'r1', 'w1'])
})

test('importProject stores the checked project under a new id', () => {
  const { state } = setup()
  const id = state.importProject((projectId) => ({ id: projectId, name: 'I', settings: {}, globalSessions: [], repositories: [
    { id: 'rX', name: 'r', path: '/r/a', branchData: {}, worktrees: [] }
  ] }))
  assert.equal(id, 'id1')
  assert.equal(state.require(id).repositories[0].id, 'rX')
})
