// The Colima environments' poll, for the env badges, the Env panel and
// Settings' orphan list: a Local server window's V2Workspace runs it. It starts once a repository has environments on:
// the tool check first (colima and docker on PATH), then `colima list` every
// ENV_POLL_MS. refreshEnvironments no-ops until the check has passed.
import { useEffect } from 'react'
import { useAppStore } from './store'
import { refreshEnvironments } from './environmentActions'

// colima list is heavier than git worktree list — poll it less often.
const ENV_POLL_MS = 10_000

/** `allowed`: the window may run things on this machine for the project (`features.env`). */
export function useEnvironmentPoll(allowed: boolean): void {
  const envEnabled = useAppStore((s) => allowed && !!s.project?.repositories.some((r) => r.environments?.enabled))
  useEffect(() => {
    if (!envEnabled) return
    let cancelled = false
    void window.api.envCheck().then((result) => {
      if (cancelled) return
      useAppStore.getState().setEnvToolCheck(result)
      void refreshEnvironments()
    })
    const interval = setInterval(() => void refreshEnvironments(), ENV_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [envEnabled])
}
