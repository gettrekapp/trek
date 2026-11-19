// The environments' list in the plugin's store (plugins E3; the window's environmentActions.ts
// before): one colima list on the server's machine per repository with environments on (which names
// its VMs by its key), asked by the Runtime's poll and after every operation, so the badges change
// at once. An answer that arrives once the host no longer serves the window is dropped.
import type { ClientPluginHost } from '../../../src/shared/plugins/client.ts'
import { envListProblem } from '../shared/environments.ts'
import { envApi } from './api.ts'
import { envOn } from './settings.ts'
import { useColimaStore } from './store.ts'

export async function refreshEnvironments(host: ClientPluginHost): Promise<void> {
  const { toolCheck, setEnvironments, setListError } = useColimaStore.getState()
  const repos = host.repos().filter(envOn)
  if (repos.length === 0 || !toolCheck?.ok) {
    // Nothing is listed (environments off, or the tools missing): no registry error to show either.
    setListError(null)
    return
  }
  try {
    const lists = await Promise.all(repos.map((r) => envApi(host).list(r.id)))
    if (!host.isCurrent()) return
    setEnvironments(lists.flat())
    setListError(null)
  } catch (err) {
    if (!host.isCurrent()) return
    // A registry the server cannot read stays broken until someone fixes the file: say so (the Env
    // panel, Settings). Anything else is a colima hiccup or a dropped link: the last known state
    // stays, and the next poll retries.
    const problem = envListProblem(err)
    if (problem) setListError(problem)
  }
}
