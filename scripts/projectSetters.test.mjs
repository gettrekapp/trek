// scripts/projectSetters.test.mjs — the store's project setters call the server window's, or nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setProjectSetters, viaServer } from '../src/renderer/src/projectSetters.ts'

test('with no project setters, a store setter does nothing', () => {
  setProjectSetters(null)
  assert.doesNotThrow(() => viaServer('renameTerminal')('t1', 'New', 'Old'))
})

test("a store setter calls the installed project setter with its arguments, looked up at each call", () => {
  const calls = []
  const rename = viaServer('renameTerminal')
  setProjectSetters({ renameTerminal: (...args) => calls.push(['first', ...args]) })
  rename('t1', 'New', 'Old')
  // Another window's setters, installed after the store setter was made: the call follows them.
  setProjectSetters({ renameTerminal: (...args) => calls.push(['second', ...args]) })
  rename('t2', 'Other')
  setProjectSetters(null)
  rename('t3', 'Gone')
  assert.deepEqual(calls, [
    ['first', 't1', 'New', 'Old'],
    ['second', 't2', 'Other']
  ])
})

test('each store setter reaches only its own name', () => {
  const calls = []
  setProjectSetters({ setBranchNote: (...args) => calls.push(['note', ...args]), setAudioAlerts: (on) => calls.push(['audio', on]) })
  viaServer('setBranchNote')('r1', 'main', 'hi')
  viaServer('setAudioAlerts')(false)
  viaServer('setBranchTag')('r1', 'main', 'x')
  setProjectSetters(null)
  assert.deepEqual(calls, [
    ['note', 'r1', 'main', 'hi'],
    ['audio', false]
  ])
})
