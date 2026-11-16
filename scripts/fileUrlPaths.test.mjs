// A file: URL's .pathname is not a filesystem path on Windows: new URL('..', import.meta.url).pathname
// is /D:/a/trek/trek/, which join() and resolve() read as D:\D:\a\trek\trek\ and which spawn()
// rejects as a cwd (reported as `spawn <program> ENOENT`). The smokes take paths from
// fileURLToPath(new URL(…, import.meta.url)) instead; this keeps .pathname from coming back.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = fileURLToPath(new URL('.', import.meta.url))
const MISUSE = /import\.meta\.url\s*\)\s*\.pathname/

test('no script takes a path from import.meta.url’s .pathname', () => {
  const offenders = []
  for (const name of readdirSync(scripts)) {
    if (!/\.(mjs|cjs|js|ts)$/.test(name) || name === 'fileUrlPaths.test.mjs') continue
    readFileSync(join(scripts, name), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (MISUSE.test(line)) offenders.push(`scripts/${name}:${i + 1}: ${line.trim()}`)
      })
  }
  assert.deepEqual(offenders, [], 'use fileURLToPath(new URL(…, import.meta.url))')
})

test('the pattern catches the misuse and not fileURLToPath', () => {
  assert.equal(MISUSE.test("const root = new URL('..', import.meta.url).pathname"), true)
  assert.equal(MISUSE.test("cwd: new URL('../server/', import.meta.url) .pathname,"), true)
  assert.equal(MISUSE.test("const root = fileURLToPath(new URL('..', import.meta.url))"), false)
  assert.equal(MISUSE.test("check('lands on /login', new URL(page.url()).pathname, '/login')"), false)
})
