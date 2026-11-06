// scripts/navigationRules.test.mjs — which URLs a window may load, and which go to the browser.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { isAppUrl, isExternalUrl } from '../src/main/navigationRules.ts'

const dir = '/Applications/Trek.app/Contents/Resources/app/out/renderer'
const fileUrl = (p) => pathToFileURL(p).href

test('dev: only the dev server origin is the app', () => {
  const dev = 'http://localhost:5173'
  assert.equal(isAppUrl('http://localhost:5173/', dev, dir), true)
  assert.equal(isAppUrl('http://localhost:5173/src/main.tsx?t=1#x', dev, dir), true)
  assert.equal(isAppUrl('http://localhost:5173', 'http://localhost:5173/', dir), true)
  assert.equal(isAppUrl('http://localhost:5173.evil.com/', dev, dir), false)
  assert.equal(isAppUrl('http://localhost:5173@evil.com/', dev, dir), false)
  assert.equal(isAppUrl('http://localhost:5174/', dev, dir), false)
  assert.equal(isAppUrl('https://localhost:5173/', dev, dir), false)
  assert.equal(isAppUrl('http://127.0.0.1:5173/', dev, dir), false)
  assert.equal(isAppUrl('http://evil.com/?http://localhost:5173', dev, dir), false)
  // A build's file pages are not the app while running from the dev server.
  assert.equal(isAppUrl(fileUrl(`${dir}/index.html`), dev, dir), false)
})

test('build: only files inside the renderer directory are the app', () => {
  assert.equal(isAppUrl(fileUrl(`${dir}/index.html`), null, dir), true)
  assert.equal(isAppUrl(`${fileUrl(`${dir}/index.html`)}#/settings`, null, dir), true)
  assert.equal(isAppUrl(fileUrl(`${dir}/assets/x.js`), null, dir), true)
  assert.equal(isAppUrl(fileUrl('/etc/passwd'), null, dir), false)
  assert.equal(isAppUrl(fileUrl(dir), null, dir), false)
  assert.equal(isAppUrl(`${fileUrl(dir)}/../../evil.html`, null, dir), false)
  assert.equal(isAppUrl(`${fileUrl(dir)}/%2e%2e/evil.html`, null, dir), false)
  assert.equal(isAppUrl(fileUrl(`${dir}-evil/index.html`), null, dir), false)
  assert.equal(isAppUrl(`file://evil.com${dir}/index.html`, null, dir), false)
  assert.equal(isAppUrl('https://example.com/', null, dir), false)
  assert.equal(isAppUrl('not a url', null, dir), false)
  assert.equal(isAppUrl('', null, dir), false)
})

test('isExternalUrl allows http(s) only', () => {
  assert.equal(isExternalUrl('https://github.com/x/y/pull/1'), true)
  assert.equal(isExternalUrl('http://localhost:3000'), true)
  assert.equal(isExternalUrl('file:///etc/passwd'), false)
  assert.equal(isExternalUrl('javascript:alert(1)'), false)
  assert.equal(isExternalUrl('smb://host/share'), false)
  assert.equal(isExternalUrl('nope'), false)
})
