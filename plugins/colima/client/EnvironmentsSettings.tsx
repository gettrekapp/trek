// Settings → Environments (plugins E3; the window's EnvironmentsTab before): the repository's
// environments settings and the orphaned VMs. Core shows the tab, its heading and the repository
// picker where the plugin is on; this is the rest.
import { usePluginHost, type PluginRepo } from '../../../src/shared/plugins/client.ts'
import type { PluginFieldValue } from '../../../src/shared/plugins/manifest.ts'
import { ENV_DEFAULTS } from '../shared/environments.ts'
import { envApi } from './api.ts'
import { refreshEnvironments } from './poll.ts'
import { patchedSettings } from './settings.ts'
import { useColimaStore } from './store.ts'

export function EnvironmentsSettings({ repo }: { repo: PluginRepo }): React.JSX.Element {
  const host = usePluginHost()
  const { SettingNumber, SettingText } = host.components
  const settings = repo.settings
  const environments = useColimaStore((s) => s.environments)
  const envBusy = useColimaStore((s) => s.busy)
  const setEnvBusy = useColimaStore((s) => s.setBusy)
  const envToolCheck = useColimaStore((s) => s.toolCheck)
  const envListError = useColimaStore((s) => s.listError)

  const num = (key: string, fallback: number): number => (typeof settings[key] === 'number' ? (settings[key] as number) : fallback)
  const flag = (key: string, fallback: boolean): boolean => (typeof settings[key] === 'boolean' ? (settings[key] as boolean) : fallback)
  const text = (key: string): string => (typeof settings[key] === 'string' ? (settings[key] as string) : '')

  // Built on what the window shows now (a pending edit included), so a second edit keeps the first.
  const updateEnv = (patch: Readonly<Record<string, PluginFieldValue | undefined>>): void => {
    const shown = host.repos().find((r) => r.id === repo.id) ?? repo
    host.setRepoSettings(repo.id, patchedSettings(shown, patch))
  }

  // While the server cannot read its registry it cannot tell an orphan from a worktree's VM: no
  // delete is offered from the last list (envListError says why).
  const orphans = Object.values(environments).filter((e) => e.orphaned)

  const destroyOrphan = async (profile: string): Promise<void> => {
    const known = environments[profile]?.worktreePath
    const ok = await host.confirm({
      title: 'Remove environment',
      message: `Delete the Colima VM "${profile}"?`,
      // A VM this server has no entry for may be another Trek's or trek-server's on this machine
      // (another Local profile's registry is read, but not every server's).
      detail: known
        ? `Its worktree (${known}) is gone. Deleting the VM removes its containers and volumes.`
        : 'This server has no worktree for it: it may belong to another Trek or trek-server on this machine. Deleting it removes the VM and its containers and volumes.',
      confirmLabel: 'Delete'
    })
    if (!ok) return
    setEnvBusy(profile, 'destroy')
    try {
      await envApi(host).destroy(profile)
    } catch (err) {
      void host.showError('Could not remove environment', String(err))
    } finally {
      useColimaStore.getState().setBusy(profile, null)
      void refreshEnvironments(host)
    }
  }

  return (
    <>
      <label className="settings-row">
        <input type="checkbox" checked={settings.enabled === true} onChange={(e) => updateEnv({ enabled: e.target.checked })} />
        <span className="settings-label">
          <span className="settings-name">Per-worktree Docker environments</span>
          <span className="settings-desc">
            Run each worktree&apos;s docker-compose stack in its own Colima VM, so fixed host
            ports never collide across worktrees. Requires colima and the docker CLI.
          </span>
          {envToolCheck && !envToolCheck.ok && <span className="settings-desc settings-warn">{envToolCheck.error}</span>}
          {envListError && <span className="settings-desc settings-warn">{envListError}</span>}
        </span>
      </label>
      {settings.enabled === true && (
        <>
          <div className="settings-row">
            <span className="settings-label">
              <span className="settings-name">VM size</span>
              <span className="settings-desc">Resources for each new VM (existing VMs keep their size)</span>
            </span>
            <span className="env-size-inputs">
              <label>
                CPUs
                <SettingNumber min={1} value={num('cpu', ENV_DEFAULTS.cpu)} fallback={ENV_DEFAULTS.cpu} onCommit={(cpu) => updateEnv({ cpu })} />
              </label>
              <label>
                Memory GiB
                <SettingNumber min={1} value={num('memory', ENV_DEFAULTS.memory)} fallback={ENV_DEFAULTS.memory} onCommit={(memory) => updateEnv({ memory })} />
              </label>
              <label>
                Disk GiB
                <SettingNumber min={5} value={num('disk', ENV_DEFAULTS.disk)} fallback={ENV_DEFAULTS.disk} onCommit={(disk) => updateEnv({ disk })} />
              </label>
            </span>
          </div>
          <label className="settings-row">
            <input type="checkbox" checked={flag('rosetta', ENV_DEFAULTS.rosetta)} onChange={(e) => updateEnv({ rosetta: e.target.checked })} />
            <span className="settings-label">
              <span className="settings-name">Rosetta (x86_64 emulation)</span>
              <span className="settings-desc">
                Run amd64 images via Rosetta 2 using Apple&apos;s VZ runtime (Apple Silicon
                only). Applies to new VMs — destroy and recreate an environment to change it.
              </span>
            </span>
          </label>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={flag('networkAddress', ENV_DEFAULTS.networkAddress)}
              onChange={(e) => updateEnv({ networkAddress: e.target.checked })}
            />
            <span className="settings-label">
              <span className="settings-name">Per-VM IP address</span>
              <span className="settings-desc">
                Give each VM its own IP (needs Colima&apos;s one-time sudo network helper). When
                off, ports forward to localhost and can collide across running worktrees.
              </span>
            </span>
          </label>
          <div className="settings-row">
            <span className="settings-label">
              <span className="settings-name">Compose file</span>
              <span className="settings-desc">Path relative to each worktree</span>
            </span>
            <SettingText
              key={repo.id}
              className="settings-select"
              placeholder={ENV_DEFAULTS.composeFile}
              value={text('composeFile')}
              onCommit={(value) => updateEnv({ composeFile: value || undefined })}
            />
          </div>
          {!envListError && orphans.length > 0 && (
            <div className="settings-row env-orphans">
              <span className="settings-label">
                <span className="settings-name">Orphaned environments</span>
                <span className="settings-desc">VMs whose worktree no longer exists (e.g. after a crash)</span>
                {orphans.map((o) => (
                  <span key={o.profile} className="env-orphan-row">
                    <span className={`docker-dot ${o.vmState === 'running' ? 'running' : 'exited'}`} />
                    {o.profile}
                    {o.branch ? ` (${o.branch})` : ''}
                    <button disabled={!!envBusy[o.profile]} onClick={() => void destroyOrphan(o.profile)}>
                      {envBusy[o.profile] === 'destroy' ? 'Deleting…' : 'Delete'}
                    </button>
                  </span>
                ))}
              </span>
            </div>
          )}
        </>
      )}
    </>
  )
}
