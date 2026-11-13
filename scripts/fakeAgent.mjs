// scripts/fakeAgent.mjs — a fake agent CLI for the smokes, on every platform: a Node script, and
// the launcher a session runs it by. POSIX: an executable sh script that execs node on it.
// Windows: an npm-style shim (cmd-shim's template, scripts/fixtures/cmd-shim/claude.cmd), which a
// session unwraps to `node <script>` (server/src/sessions/winLaunch.ts), as it would for an agent
// installed with npm. Returns the launcher's path: what a config's `command` names.
//
//   const agent = writeFakeAgent(dir, 'fake-agent', "console.log('FAKE_AGENT ' + process.argv.slice(2).join(' ')); setTimeout(() => process.exit(7), 1000)")
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const shim = (script) =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
    ''
  ].join('\r\n')

/** Writes `<name>.mjs` holding `source`, and its launcher (`<name>`, or `<name>.cmd` on Windows). */
export function writeFakeAgent(dir, name, source, platform = process.platform) {
  const script = `${name}.mjs`
  writeFileSync(join(dir, script), `${source}\n`)
  if (platform === 'win32') {
    const launcher = join(dir, `${name}.cmd`)
    writeFileSync(launcher, shim(script))
    return launcher
  }
  const launcher = join(dir, name)
  writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/${script}" "$@"\n`, { mode: 0o755 })
  return launcher
}
