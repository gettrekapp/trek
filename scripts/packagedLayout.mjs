// scripts/packagedLayout.mjs — a packaged Trek's layout, for the smokes' --packaged: a .app on
// macOS, electron-builder's install or unpacked directory on Linux (/opt/Trek, dist/linux-unpacked),
// and the NSIS install or unpacked directory on Windows (%LOCALAPPDATA%\Programs\trek, dist/win-unpacked).
import { posix } from 'node:path'

const { join } = posix

/** { executable, resources } of the packaged app at `path`. */
export function packagedLayout(path, platform = process.platform) {
  if (platform === 'darwin') return { executable: join(path, 'Contents', 'MacOS', 'Trek'), resources: join(path, 'Contents', 'Resources') }
  if (platform === 'linux') return { executable: join(path, 'trek'), resources: join(path, 'resources') }
  if (platform === 'win32') return { executable: join(path, 'Trek.exe'), resources: join(path, 'resources') }
  throw new Error(`no packaged layout for ${platform}`)
}

/** The trek-server bundle the app runs its Local server from. */
export function packagedServerBundle(layout) {
  return join(layout.resources, 'app.asar', 'out', 'server', 'trek-server.cjs')
}

/** Where `electron-builder --dir` leaves the app, relative to the repository. */
export function unpackedDir(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return 'dist/mac-arm64/Trek.app'
  if (platform === 'linux') return arch === 'arm64' ? 'dist/linux-arm64-unpacked' : 'dist/linux-unpacked'
  if (platform === 'win32') return 'dist/win-unpacked'
  throw new Error(`no packaged layout for ${platform}`)
}
