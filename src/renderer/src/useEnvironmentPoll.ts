// The Colima environments' poll, for the env badges, the Env panel and
// Settings' orphan list: a server window's V2Workspace runs it, with the `env`
// feature (the server runs them on its machine). It starts once a repository
// has environments on: the tool check first (colima and docker on the server's
// PATH), asked again each ENV_POLL_MS until it answers, then `colima list`
// every ENV_POLL_MS. refreshEnvironments no-ops until the check has passed; a
// failed check is asked again every minute (envPollTick), so a colima or
// docker installed on the server meanwhile is picked up. One check at a time.
import { useEffect } from 'react'
import { useAppStore } from './store'
import { getBackend } from './backend'
import { refreshEnvironments } from './environmentActions'
import { envPollTick } from './envPollTick'

// colima list is heavier than git worktree list — poll it less often.
const ENV_POLL_MS = 10_000

/** `allowed`: the window's server runs the environments (`features.env`). */
export function useEnvironmentPoll(allowed: boolean): void {
  // Paused while the link is down: the server can't answer, and the check runs again once it is back.
  const envEnabled = useAppStore((s) => allowed && !s.serverOffline && !!s.project?.repositories.some((r) => r.environments?.enabled))
  useEffect(() => {
    if (!envEnabled) return
    let cancelled = false
    let checking = false
    // The tool check; until one answers (a request that timed out or failed), each tick asks again.
    const check = (): void => {
      if (checking) return
      checking = true
      const backend = getBackend()
      backend.env
        .check()
        .then((result) => {
          if (cancelled || getBackend() !== backend) return
          useAppStore.getState().setEnvToolCheck(result)
          void refreshEnvironments(backend)
        })
        .catch(() => {
          // no answer: the next tick asks again (and the link coming back reruns this effect)
        })
        .finally(() => {
          checking = false
        })
    }
    check()
    let tick = 0
    const interval = setInterval(() => {
      if (envPollTick(useAppStore.getState().envToolCheck, ++tick) === 'check') check()
      else void refreshEnvironments()
    }, ENV_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [envEnabled])
}
