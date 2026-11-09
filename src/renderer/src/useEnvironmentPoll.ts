// The Colima environments' poll, for the env badges, the Env panel and
// Settings' orphan list: a server window's V2Workspace runs it, with the `env`
// feature (the server runs them on its machine). It starts once a repository
// has environments on: the tool check first (colima and docker on the server's
// PATH), then `colima list` every ENV_POLL_MS. refreshEnvironments no-ops until
// the check has passed.
import { useEffect } from 'react'
import { useAppStore } from './store'
import { getBackend } from './backend'
import { refreshEnvironments } from './environmentActions'

// colima list is heavier than git worktree list — poll it less often.
const ENV_POLL_MS = 10_000

/** `allowed`: the window's server runs the environments (`features.env`). */
export function useEnvironmentPoll(allowed: boolean): void {
  // Paused while the link is down: the server can't answer, and the check runs again once it is back.
  const envEnabled = useAppStore((s) => allowed && !s.serverOffline && !!s.project?.repositories.some((r) => r.environments?.enabled))
  useEffect(() => {
    if (!envEnabled) return
    let cancelled = false
    getBackend()
      .env.check()
      .then((result) => {
        if (cancelled) return
        useAppStore.getState().setEnvToolCheck(result)
        void refreshEnvironments()
      })
      .catch(() => {
        // the link dropped: asked again when it is back (serverOffline above)
      })
    const interval = setInterval(() => void refreshEnvironments(), ENV_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [envEnabled])
}
