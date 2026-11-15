import { useAppStore } from '../../store'
import { refreshEnvironments } from '../../environmentActions'
import { ENV_DEFAULTS } from '../../../../shared/environments'
import { getBackend } from '../../backend'
import { SettingNumber, SettingText } from '../SettingText'
import type { EnvironmentSettings, Repository } from '../../../../shared/types'

interface Props {
  /** The repository whose environments these are */
  repo: Repository | undefined
  repoSelector: React.ReactNode
}

/** Settings → Environments: shown where the window's server runs them (its VMs are the server's). */
export function EnvironmentsTab({ repo, repoSelector }: Props): React.JSX.Element {
  const envSettings = repo?.environments
  const setEnvironmentSettings = useAppStore((s) => s.setEnvironmentSettings)
  const environments = useAppStore((s) => s.environments)
  const envBusy = useAppStore((s) => s.envBusy)
  const setEnvBusy = useAppStore((s) => s.setEnvBusy)
  const envToolCheck = useAppStore((s) => s.envToolCheck)
  const envListError = useAppStore((s) => s.envListError)

  const updateEnv = (patch: Partial<EnvironmentSettings>): void => {
    if (repo) setEnvironmentSettings(repo.id, patch)
  }

  // While the server cannot read its registry it cannot tell an orphan from a worktree's VM: no
  // delete is offered from the last list (envListError says why).
  const orphans = Object.values(environments).filter((e) => e.orphaned)

  const destroyOrphan = async (profile: string): Promise<void> => {
    const known = environments[profile]?.worktreePath
    const ok = await window.api.confirm({
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
      await getBackend().env.destroy(profile)
    } catch (err) {
      void window.api.showError('Could not remove environment', String(err))
    } finally {
      useAppStore.getState().setEnvBusy(profile, null)
      void refreshEnvironments()
    }
  }

  return (
    <>
      <h3>Environments</h3>
      {repoSelector}
      <label className="settings-row">
        <input
          type="checkbox"
          checked={envSettings?.enabled ?? false}
          onChange={(e) => updateEnv({ enabled: e.target.checked })}
        />
        <span className="settings-label">
          <span className="settings-name">Per-worktree Docker environments</span>
          <span className="settings-desc">
            Run each worktree&apos;s docker-compose stack in its own Colima VM, so fixed host
            ports never collide across worktrees. Requires colima and the docker CLI.
          </span>
          {envToolCheck && !envToolCheck.ok && (
            <span className="settings-desc settings-warn">{envToolCheck.error}</span>
          )}
          {envListError && <span className="settings-desc settings-warn">{envListError}</span>}
        </span>
      </label>
      {envSettings?.enabled && (
        <>
          <div className="settings-row">
            <span className="settings-label">
              <span className="settings-name">VM size</span>
              <span className="settings-desc">
                Resources for each new VM (existing VMs keep their size)
              </span>
            </span>
            <span className="env-size-inputs">
              <label>
                CPUs
                <SettingNumber
                  min={1}
                  value={envSettings.cpu ?? ENV_DEFAULTS.cpu}
                  fallback={ENV_DEFAULTS.cpu}
                  onCommit={(cpu) => updateEnv({ cpu })}
                />
              </label>
              <label>
                Memory GiB
                <SettingNumber
                  min={1}
                  value={envSettings.memory ?? ENV_DEFAULTS.memory}
                  fallback={ENV_DEFAULTS.memory}
                  onCommit={(memory) => updateEnv({ memory })}
                />
              </label>
              <label>
                Disk GiB
                <SettingNumber
                  min={5}
                  value={envSettings.disk ?? ENV_DEFAULTS.disk}
                  fallback={ENV_DEFAULTS.disk}
                  onCommit={(disk) => updateEnv({ disk })}
                />
              </label>
            </span>
          </div>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={envSettings.rosetta ?? ENV_DEFAULTS.rosetta}
              onChange={(e) => updateEnv({ rosetta: e.target.checked })}
            />
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
              checked={envSettings.networkAddress ?? ENV_DEFAULTS.networkAddress}
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
              key={repo?.id}
              className="settings-select"
              placeholder={ENV_DEFAULTS.composeFile}
              value={envSettings.composeFile ?? ''}
              onCommit={(text) => updateEnv({ composeFile: text || undefined })}
            />
          </div>
          {!envListError && orphans.length > 0 && (
            <div className="settings-row env-orphans">
              <span className="settings-label">
                <span className="settings-name">Orphaned environments</span>
                <span className="settings-desc">
                  VMs whose worktree no longer exists (e.g. after a crash)
                </span>
                {orphans.map((o) => (
                  <span key={o.profile} className="env-orphan-row">
                    <span className={`docker-dot ${o.vmState === 'running' ? 'running' : 'exited'}`} />
                    {o.profile}
                    {o.branch ? ` (${o.branch})` : ''}
                    <button
                      disabled={!!envBusy[o.profile]}
                      onClick={() => void destroyOrphan(o.profile)}
                    >
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
