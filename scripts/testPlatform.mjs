// scripts/testPlatform.mjs — the one way a test skips by platform, so every skip says why and
// scripts/testPlatform.test.mjs can list them (no silent `if (win32) return`).
//
//   test('…', { skip: posixOnly('a POSIX shell') }, () => …)
//   test('…', { skip: windowsOnly('ConPTY') }, () => …)

import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'

const RETRIES = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }

/**
 * Removes a test's temp directory, waiting out a busy one (up to about 5 s). Windows refuses to
 * remove a directory a process still runs in (EBUSY), such as a git the test's poller started;
 * and a cleanup hook that throws stops the hooks after it (node:test runs them in the order they
 * were registered), so what they would have stopped keeps the test file's process alive.
 */
export const removeDir = (dir) => {
  try {
    rmSync(dir, RETRIES)
  } catch (err) {
    reportHolders(dir, err)
    throw err
  }
}

/**
 * As removeDir, for a fixture that runs a server over the directory: call it in the same hook,
 * after stopping what the fixture started. Its retries leave the event loop running, so a child
 * process this one must still read from (or reap) can finish and let go of the directory.
 */
export const removeDirWhenFree = (dir) =>
  rm(dir, RETRIES).catch((err) => {
    reportHolders(dir, err)
    throw err
  })

/** Windows: the processes this one started that are still running, when a directory stays busy. */
function reportHolders(dir, err) {
  if (process.platform !== 'win32') return
  try {
    const json = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
    const all = [].concat(JSON.parse(json))
    const mine = new Set([process.pid])
    for (let grew = true; grew; ) {
      grew = false
      for (const p of all) if (mine.has(p.ParentProcessId) && !mine.has(p.ProcessId)) { mine.add(p.ProcessId); grew = true }
    }
    // git and its helpers too, whoever started them: a parent that exited leaves no trail.
    const shown = all.filter((p) => p.ProcessId !== process.pid && (mine.has(p.ProcessId) || /^(git|sh|bash|conhost|OpenConsole)/i.test(p.Name ?? '')))
    console.error(`[removeDir] ${dir} could not be removed (${err.code}); pid ${process.pid}'s descendants and the git processes running:`)
    for (const p of shown) console.error(`[removeDir]   ${p.ProcessId} <- ${p.ParentProcessId} ${p.Name} ${String(p.CommandLine ?? '').slice(0, 300)}`)
    if (shown.length === 0) console.error('[removeDir]   none: the handle is in this process')
  } catch (failed) {
    console.error(`[removeDir] ${dir} could not be removed (${err.code}); listing processes failed: ${failed.message}`)
  }
}

/** Skipped on Windows, for a feature that exists only on macOS and Linux. */
export const posixOnly = (reason) => (process.platform === 'win32' ? `POSIX only: ${reason}` : false)

/** Run only on Windows (the windows-latest CI job), for what only Windows has. */
export const windowsOnly = (reason) => (process.platform !== 'win32' ? `Windows only: ${reason}` : false)
