// The env plugin's Runtime (plugins E3; the window's useEnvironmentPoll before): one per window and
// backend. Once a repository has environments on it polls them on the server's machine: the tool
// check first (colima and docker on the server's PATH), asked each ENV_POLL_MS until it answers, then
// `colima list` every ENV_POLL_MS (refreshEnvironments, a no-op until the check has passed). A failed
// check is asked again every minute (envPollTick), and on a reconnect (host.onChanged). One check
// at a time. A request while the link is down fails at once; the poll goes on.
import { useEffect } from 'react'
import { usePluginHost, usePluginRepos } from '../../../src/shared/plugins/client.ts'
import { envApi } from './api.ts'
import { refreshEnvironments } from './poll.ts'
import { envPollTick } from './pollTick.ts'
import { envOn } from './settings.ts'
import { useColimaStore } from './store.ts'

// colima list is heavier than git worktree list: polled less often.
const ENV_POLL_MS = 10_000

export function ColimaRuntime(): null {
  const host = usePluginHost()
  const anyOn = usePluginRepos().some(envOn)
  // Another backend remounts this (its key): nothing of the last server's or project's stays.
  useEffect(() => {
    useColimaStore.getState().reset()
    return () => useColimaStore.getState().reset()
  }, [host])
  useEffect(() => {
    if (!anyOn) return
    let cancelled = false
    let checking = false
    const check = (): void => {
      if (checking) return
      checking = true
      envApi(host)
        .check()
        .then((result) => {
          if (cancelled || !host.isCurrent()) return
          useColimaStore.getState().setToolCheck(result)
          void refreshEnvironments(host)
        })
        .catch(() => {
          // no answer: the next tick asks again
        })
        .finally(() => {
          checking = false
        })
    }
    check()
    const offChanged = host.onChanged(check)
    let tick = 0
    const interval = setInterval(() => {
      if (envPollTick(useColimaStore.getState().toolCheck, ++tick) === 'check') check()
      else void refreshEnvironments(host)
    }, ENV_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
      offChanged()
    }
  }, [host, anyOn])
  return null
}
