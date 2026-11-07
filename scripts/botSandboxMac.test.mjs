// scripts/botSandboxMac.test.mjs — the macOS sandbox for real: sandbox-exec with Trek's profile
// around plain shells, python and node, against a fake userData. No Claude CLI. macOS only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeSandbox, sandboxFor, SANDBOX_EXEC } from '../src/host/bot/sandbox.ts'

const skip = process.platform !== 'darwin' && 'macOS only'
// The LaunchServices check writes an app and opens it for real (the control launches it outside the
// sandbox), so it is opt-in: `npm run test:bot-sandbox-mac` sets this.
const skipApp = skip || (process.env.TREK_SANDBOX_APP_TEST !== '1' && 'opt-in: npm run test:bot-sandbox-mac')
const SECRET = 'TOPSECRET-123'
const root = skip ? '' : realpathSync(mkdtempSync(join(tmpdir(), 'bot-sandbox-')))
const ancestor = join(root, 'Application Support')
const userData = join(ancestor, 'Trek Dev')
const secret = join(userData, 'server-tokens.json')
const work = join(root, 'work')
if (!skip) {
  mkdirSync(userData, { recursive: true })
  writeFileSync(secret, SECRET)
  mkdirSync(work)
  symlinkSync(secret, join(work, 'link.json'))
}
const sandbox = skip ? null : sandboxFor('darwin', userData).sandbox
const hasPython = !skip && spawnSync('python3', ['-I', '-c', '1']).status === 0

/** Runs `script` with /bin/sh inside the sandbox, in `work`. */
const sh = (script) => {
  const ran = spawnSync(sandbox.command, [...sandbox.args, '/bin/sh', '-c', script], { cwd: work, encoding: 'utf8', timeout: 20_000 })
  return { status: ran.status, out: `${ran.stdout}${ran.stderr}` }
}
const DENIED = /Operation not permitted|PermissionError|EPERM/
const expectDenied = (script) => {
  const ran = sh(script)
  assert.ok(!ran.out.includes(SECRET), `leaked: ${script}\n${ran.out}`)
  assert.match(ran.out, DENIED, script)
  assert.notEqual(ran.status, 0, script)
}
const waitFor = (path, ms) => {
  const until = Date.now() + ms
  while (!existsSync(path) && Date.now() < until) spawnSync('/bin/sleep', ['0.2'])
  return existsSync(path)
}

test.after(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

test('reads of userData are denied however the path is spelled', { skip }, () => {
  for (const script of [
    `cat "${secret}"`,
    `cat "$(echo "${userData}")/server-tokens.json"`,
    `d="${ancestor}"; cat "$d/Trek Dev/server-tokens.json"`,
    'cat link.json',
    `cat "${secret.toUpperCase()}"`,
    `cd "${ancestor}" && cat "./Trek Dev/../Trek Dev/server-tokens.json"`,
    `ls "${userData}"`,
    `grep -R TOPSECRET "${ancestor}"`,
    `cp -R "${userData}" copied`,
    `tar cf - "${userData}" > /dev/null`,
    `node -e "console.log(require('fs').readFileSync('${secret}', 'utf8'))"`
  ]) {
    expectDenied(script)
  }
})

test('python is denied too', { skip: skip || (!hasPython && 'no python3') }, () => {
  expectDenied(`python3 -I -c "print(open('${secret}').read())"`)
})

test('writes, moves and new links in userData are denied', { skip }, () => {
  for (const script of [
    `echo x > "${userData}/new.json"`,
    `rm "${secret}"`,
    `mv "${secret}" stolen.json`,
    `ln "${secret}" hard.json`,
    `node -e "require('fs').writeFileSync('${userData}/n.json', 'x')"`
  ]) {
    expectDenied(script)
  }
  assert.equal(readFileSync(secret, 'utf8'), SECRET)
  assert.equal(existsSync(join(userData, 'new.json')), false)
})

test('an ancestor of userData cannot be renamed, but files in it still can be made and removed', { skip }, () => {
  expectDenied(`mv "${ancestor}" "${root}/moved" && cat "${root}/moved/Trek Dev/server-tokens.json"`)
  expectDenied(`mv "${root}" "${root}-moved"`)
  assert.equal(existsSync(secret), true)
  assert.equal(sh(`touch "${ancestor}/other" && mv "${ancestor}/other" "${ancestor}/other2" && rm "${ancestor}/other2"`).status, 0)
})

test('an app the bot writes cannot be opened through LaunchServices', { skip: skipApp }, () => {
  const app = join(work, 'Esc.app')
  const escaped = join(work, 'escaped.txt')
  const id = `com.trek.sandbox-test.${process.pid}`
  const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>esc</string><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/></dict></plist>`
  // Written from inside the sandbox, as the bot would.
  const made = sh(
    `mkdir -p Esc.app/Contents/MacOS && printf '%s' '${plist}' > Esc.app/Contents/Info.plist && ` +
    `printf '#!/bin/sh\\ncat "%s" > "%s"\\n' "${secret}" "${escaped}" > Esc.app/Contents/MacOS/esc && chmod +x Esc.app/Contents/MacOS/esc && ` +
    '/usr/bin/open ./Esc.app'
  )
  assert.notEqual(made.status, 0, made.out)
  assert.equal(waitFor(escaped, 3000), false, 'the app ran')
  // The same app opened from outside the sandbox does escape, so the check above means something.
  assert.equal(spawnSync('/usr/bin/open', [app]).status, 0)
  assert.equal(waitFor(escaped, 10_000), true)
  assert.equal(readFileSync(escaped, 'utf8'), SECRET)
})

test('ordinary commands still work', { skip }, () => {
  for (const script of [
    '/usr/bin/true',
    'git --version',
    'echo ok > made.txt && cat made.txt && rm made.txt',
    'node -e "console.log(1 + 1)"',
    'ls ~ > /dev/null && ls / > /dev/null',
    `ls "${ancestor}" > /dev/null`
  ]) {
    assert.equal(sh(script).status, 0, script)
  }
})

test('the probe passes for the real sandbox', { skip }, async () => {
  const canary = join(userData, 'bot-sandbox-canary.txt')
  writeFileSync(canary, 'canary-abc')
  assert.equal(await probeSandbox(sandbox, { path: canary, text: 'canary-abc' }), null)
})

test('the probe catches a sandbox that hides nothing, a non-canonical path, a missing command and a bad profile', { skip }, async () => {
  const canary = { path: join(userData, 'bot-sandbox-canary.txt'), text: 'canary-abc' }
  writeFileSync(canary.path, canary.text)
  const open = { command: SANDBOX_EXEC, args: ['-p', '(version 1)(allow default)'] }
  assert.match(await probeSandbox(open, canary), /a test read of Trek's data folder succeeded/)
  // /var is a symlink to /private/var: the profile fails open on a spelling that isn't the real path.
  const symlinked = sandboxFor('darwin', userData.replace(/^\/private\/var\//, '/var/')).sandbox
  assert.match(await probeSandbox(symlinked, canary), /a test read of Trek's data folder succeeded/)
  assert.match(await probeSandbox({ command: '/nope/sandbox-exec', args: [] }, canary), /\/nope\/sandbox-exec was not found/)
  assert.match(await probeSandbox({ command: SANDBOX_EXEC, args: ['-p', '(version 1)(bogus'] }, canary), /a test command failed/)
})
