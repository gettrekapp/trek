// scripts/v2RepoPathPrompt.test.mjs — the "Add repository" path request of a server window.
import test from 'node:test'
import assert from 'node:assert/strict'
import { answerRepoPath, cancelRepoPath, requestRepoPath } from '../src/renderer/src/v2/repoPathPrompt.ts'

test('a second request resolves the first with null', async () => {
  const first = requestRepoPath()
  const second = requestRepoPath()
  assert.equal(await first, null)
  answerRepoPath('/srv/b')
  assert.equal(await second, '/srv/b')
})

test('answers are trimmed', async () => {
  const pending = requestRepoPath()
  answerRepoPath('  /srv/app \n')
  assert.equal(await pending, '/srv/app')
})

test('a whitespace-only answer resolves null', async () => {
  const pending = requestRepoPath()
  answerRepoPath('   ')
  assert.equal(await pending, null)
})

test('answering with nothing pending does nothing', async () => {
  answerRepoPath('/srv/stray')
  cancelRepoPath()
  const next = requestRepoPath()
  answerRepoPath('/srv/next')
  assert.equal(await next, '/srv/next')
})

test('cancel resolves the pending request with null', async () => {
  const pending = requestRepoPath()
  cancelRepoPath()
  assert.equal(await pending, null)
})
