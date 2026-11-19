// The env plugin's worktree slots (plugins E3; the window's own before): the header chip, the
// sidebar row's badge and the hover card's row. The Run menu's entry is panelEntry.ts's.
import { usePluginRepos, type PluginWorktree, type WorktreeSlotProps } from '../../../src/shared/plugins/client.ts'
import { vmOf } from './panelEntry.ts'
import { envOn } from './settings.ts'
import { useColimaStore, type EnvBusyAction } from './store.ts'

const BUSY_LABELS: Record<EnvBusyAction, string> = { start: 'Env starting…', stop: 'Env stopping…', destroy: 'Env resetting…' }

/** The worktree's VM as the poll knows it, kept current; `on`: its repository has environments on. */
function useVm(worktree: PluginWorktree): ReturnType<typeof vmOf> & { on: boolean } {
  const repos = usePluginRepos()
  const environments = useColimaStore((s) => s.environments)
  const busy = useColimaStore((s) => s.busy)
  return { ...vmOf(repos, worktree, environments, busy), on: envOn(repos.find((r) => r.id === worktree.repoId)) }
}

/** The header's chip, while the VM exists: its state and address; a click opens the Env panel. */
export function EnvChip({ worktree, openPanel }: WorktreeSlotProps & { openPanel(): void }): React.JSX.Element | null {
  const { env, busy, on } = useVm(worktree)
  if (!on || !worktree.branch || !env) return null
  const label = busy ? BUSY_LABELS[busy] : env.vmState === 'running' ? `Env${env.address ? ` · ${env.address}` : ''}` : 'Env stopped'
  return (
    <span className={`chip chip-env ${busy ? 'busy' : env.vmState === 'running' ? 'running' : 'stopped'}`} title="Open environment panel" onClick={() => openPanel()}>
      {label}
    </span>
  )
}

/** The sidebar row's badge, while the poll knows the branch's VM. */
export function EnvBadge({ worktree }: WorktreeSlotProps): React.JSX.Element | null {
  const { env, busy } = useVm(worktree)
  if (!env) return null
  return (
    <span
      className={`mini-chip env ${busy ? 'busy' : env.vmState === 'running' ? 'running' : ''}`}
      title={busy ? 'Environment operation in progress' : `Environment ${env.vmState}${env.address ? ` — ${env.address}` : ''}`}
    >
      env
    </span>
  )
}

/** The hover card's Env row: "running — 10.0.0.4". */
export function EnvHoverRow({ worktree }: WorktreeSlotProps): React.JSX.Element | null {
  const { env, busy } = useVm(worktree)
  if (!env) return null
  return (
    <>
      <dt>Env</dt>
      <dd>{`${busy ? 'busy' : env.vmState}${env.address ? ` — ${env.address}` : ''}`}</dd>
    </>
  )
}
