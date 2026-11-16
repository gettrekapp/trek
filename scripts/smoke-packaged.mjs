// scripts/smoke-packaged.mjs — npm run smoke:packaged: package the app for this OS as an unpacked
// directory (dist:dir on macOS, dist:linux:dir on Linux, dist:win:dir on Windows), then run the Local
// server and app smokes against it. On Linux without a display, run it under xvfb-run -a.
import { execFileSync } from 'node:child_process'
import { unpackedDir } from './packagedLayout.mjs'

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const distDir = process.platform === 'darwin' ? 'dist:dir' : process.platform === 'win32' ? 'dist:win:dir' : 'dist:linux:dir'
run(npm, ['run', distDir])
const dir = unpackedDir()
run(process.execPath, ['scripts/local-server-smoke.mjs', '--packaged', dir])
run(process.execPath, ['scripts/local-app-smoke.mjs', '--packaged', dir])
