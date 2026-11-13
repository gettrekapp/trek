// scripts/testPlatform.mjs — the one way a test skips by platform, so every skip says why and
// scripts/testPlatform.test.mjs can list them (no silent `if (win32) return`).
//
//   test('…', { skip: posixOnly('a POSIX shell') }, () => …)
//   test('…', { skip: windowsOnly('ConPTY') }, () => …)

/** Skipped on Windows, for a feature that exists only on macOS and Linux. */
export const posixOnly = (reason) => (process.platform === 'win32' ? `POSIX only: ${reason}` : false)

/** Run only on Windows (the windows-latest CI job), for what only Windows has. */
export const windowsOnly = (reason) => (process.platform !== 'win32' ? `Windows only: ${reason}` : false)
