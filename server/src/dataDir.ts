// Where trek-server stores projects: config.dataDir or --data-dir, else the
// platform's per-user data directory.
import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME ?? env.USERPROFILE ?? homedir()
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'trek-server')
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'trek-server')
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'trek-server')
}

export function projectsDir(dataDir: string): string {
  return join(dataDir, 'projects')
}
