import { useState } from 'react'
import { DEFAULT_PERMISSION_MODE } from '../terminals'
import { CLAUDE_PERMISSION_MODES } from '../../../shared/providers/claude'
import { useAppStore } from '../store'
import { refreshEnvironments } from '../environmentActions'
import { ENV_DEFAULTS } from '../../../shared/environments'
import { LinearSettings } from './LinearSettings'
import { VoiceSettings } from './VoiceSettings'
import { NotificationSettings } from './NotificationSettings'
import { ImagePicker, SESSION_ICON_LIMITS } from './ImagePicker'
import { AppearanceSettings } from './AppearanceSettings'
import { LlmSettings } from './LlmSettings'
import { LlmPicker, useServerPicker } from './LlmPicker'
import { SettingNumber, SettingText } from './SettingText'
import { defaultSessionLlm } from '../llm'
import { settingsSections } from '../backendFeatures'
import { useFeatures } from '../useFeatures'
import type {
  SessionType,
  EnvironmentSettings,
  TerminalQuickButton,
  WorktreeTag
} from '../../../shared/types'

interface Props {
  visible: boolean
}

export function SettingsPanel({ visible }: Props): React.JSX.Element {
  // A server window edits the project's settings on the server: text is committed on blur (each
  // commit is a request), this machine's sections are hidden (but a Local window's environments,
  // and Linear everywhere), and a conflict's Reload remounts it.
  const serverWindow = useAppStore((s) => s.serverWindow !== null)
  const features = useFeatures()
  const sections = settingsSections(features)
  const live = !serverWindow
  const reload = useAppStore((s) => s.settingsReload)
  const serverDefault = useAppStore((s) => s.serverAgents?.llmDefault)
  const picker = useServerPicker()
  const audioAlerts = useAppStore((s) => s.project?.audioAlerts ?? false)
  const setAudioAlerts = useAppStore((s) => s.setAudioAlerts)
  // '' is "App default": the project leaves the mode to the app-wide Claude setting.
  const permissionMode = useAppStore((s) => s.project?.claudePermissionMode ?? '')
  const appPermissionMode = useAppStore(
    (s) => s.llmSettings?.providers.claude?.approvalMode?.trim() || DEFAULT_PERMISSION_MODE
  )
  const appPermissionLabel =
    CLAUDE_PERMISSION_MODES.find((m) => m.value === appPermissionMode)?.label ?? appPermissionMode
  const setClaudePermissionMode = useAppStore((s) => s.setClaudePermissionMode)
  const claudeArgsOverride = useAppStore((s) => s.project?.claudeArgs?.trim())
  const repositories = useAppStore((s) => s.project?.repositories) ?? []
  // Which repository the per-repository settings below edit.
  const [settingsRepoId, setSettingsRepoId] = useState<string | null>(null)
  const settingsRepo = repositories.find((r) => r.id === settingsRepoId) ?? repositories[0]
  const envSettings = settingsRepo?.environments
  const linkedDirs = settingsRepo?.linkedDirs ?? []
  const repoSelector =
    repositories.length > 1 ? (
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">Repository</span>
          <span className="settings-desc">These settings apply per repository.</span>
        </span>
        <select
          className="settings-select"
          value={settingsRepo?.id}
          onChange={(e) => setSettingsRepoId(e.target.value)}
        >
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
    ) : null
  const setEnvironmentSettings = useAppStore((s) => s.setEnvironmentSettings)
  const environments = useAppStore((s) => s.environments)
  const envBusy = useAppStore((s) => s.envBusy)
  const setEnvBusy = useAppStore((s) => s.setEnvBusy)
  const envToolCheck = useAppStore((s) => s.envToolCheck)
  // Default applied outside the selector — `?? []` inside it would return a
  // fresh array every snapshot and loop React's store re-render (error #185).
  const terminalButtons = useAppStore((s) => s.project?.terminalButtons) ?? []
  const setTerminalButtons = useAppStore((s) => s.setTerminalButtons)
  const globalTerminalButtons = useAppStore((s) => s.project?.globalTerminalButtons) ?? []
  const setGlobalTerminalButtons = useAppStore((s) => s.setGlobalTerminalButtons)
  const globalSystemPrompt = useAppStore((s) => s.project?.globalSystemPrompt) ?? ''
  const setGlobalSystemPrompt = useAppStore((s) => s.setGlobalSystemPrompt)
  const sessionSystemPrompt = useAppStore((s) => s.project?.sessionSystemPrompt) ?? ''
  const setSessionSystemPrompt = useAppStore((s) => s.setSessionSystemPrompt)
  const sessionTypes = useAppStore((s) => s.project?.sessionTypes) ?? []
  const setSessionTypes = useAppStore((s) => s.setSessionTypes)
  const setLinkedDirs = useAppStore((s) => s.setLinkedDirs)
  const worktreeTags = useAppStore((s) => s.project?.worktreeTags) ?? []
  const setWorktreeTags = useAppStore((s) => s.setWorktreeTags)
  const customTags = useAppStore((s) => s.project?.customTags) ?? []
  const setCustomTags = useAppStore((s) => s.setCustomTags)

  const updateEnv = (patch: Partial<EnvironmentSettings>): void => {
    setEnvironmentSettings(settingsRepo.id, patch)
  }

  const updateButtons = (buttons: TerminalQuickButton[]): void => {
    setTerminalButtons(buttons)
  }

  const updateGlobalButtons = (buttons: TerminalQuickButton[]): void => {
    setGlobalTerminalButtons(buttons)
  }

  const updateSessionTypes = (types: SessionType[]): void => {
    setSessionTypes(types)
  }

  const patchSessionType = (id: string, patch: Partial<SessionType>): void => {
    updateSessionTypes(sessionTypes.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  const orphans = Object.values(environments).filter((e) => e.orphaned)

  const destroyOrphan = async (profile: string): Promise<void> => {
    const ok = await window.api.confirm({
      title: 'Remove environment',
      message: `Delete the Colima VM "${profile}"?`,
      detail: 'The VM and all its container data/volumes will be removed.',
      confirmLabel: 'Delete'
    })
    if (!ok) return
    setEnvBusy(profile, 'destroy')
    try {
      await window.api.envDestroy(null, profile)
    } catch (err) {
      void window.api.showError('Could not remove environment', String(err))
    } finally {
      useAppStore.getState().setEnvBusy(profile, null)
      void refreshEnvironments()
    }
  }

  const parseDirs = (text: string): string[] =>
    text
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean)

  return (
    <div className="settings-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="settings-content" key={reload}>
        <h3>Settings</h3>
        <div className="settings-row">
          <span className="settings-label">
            <span className="settings-name">Claude session mode for this project</span>
            <span className="settings-desc">
              Permission mode passed to new Claude sessions (--permission-mode). Existing
              sessions keep the mode they were started with.
            </span>
            {claudeArgsOverride && (
              <span className="settings-desc settings-warn">
                Ignored while the project file sets claudeArgs: “{claudeArgsOverride}”
              </span>
            )}
          </span>
          <select
            className="settings-select"
            value={permissionMode}
            onChange={(e) => {
              setClaudePermissionMode(e.target.value || undefined)
            }}
          >
            <option value="">{serverWindow ? 'Server default' : `App default (${appPermissionLabel})`}</option>
            {CLAUDE_PERMISSION_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={audioAlerts}
            onChange={(e) => {
              setAudioAlerts(e.target.checked)
            }}
          />
          <span className="settings-label">
            <span className="settings-name">Audio alerts</span>
            <span className="settings-desc">
              Play a sound when an agent terminal finishes working and is ready for input
            </span>
          </span>
        </label>
        {repoSelector}
        <div className="settings-row">
          <span className="settings-label">
            <span className="settings-name">Linked directories</span>
            <span className="settings-desc">
              Comma-separated repo-relative paths (e.g. .trek) symlinked from the main
              repository into every new worktree — for local-only folders like database backups
              and secrets that aren&apos;t committed. Applies to worktrees created from now on.
            </span>
          </span>
          {live ? (
            <input
              className="settings-select"
              type="text"
              key={settingsRepo?.id}
              placeholder=".trek"
              defaultValue={linkedDirs.join(', ')}
              onBlur={(e) => {
                setLinkedDirs(settingsRepo.id, parseDirs(e.target.value))
              }}
            />
          ) : (
            <SettingText
              key={settingsRepo?.id}
              live={false}
              className="settings-select"
              placeholder=".trek"
              value={linkedDirs.join(', ')}
              onCommit={(text) => setLinkedDirs(settingsRepo.id, parseDirs(text))}
            />
          )}
        </div>
        <AppearanceSettings />
        <NotificationSettings />
        {sections.linear !== 'hidden' && <LinearSettings />}
        {sections.voice !== 'hidden' && <VoiceSettings />}
        <LlmSettings projectOnly={sections.agents === 'project'} />
        <h3>Worktree tags</h3>
        <WorktreeTagsEditor
          description="Workflow tags assignable to a worktree's branch, in menu order. New worktrees start with the first tag. Deleting a tag removes it from every branch using it."
          tags={worktreeTags}
          onChange={setWorktreeTags}
          live={live}
          usesOf={(id) =>
            repositories.flatMap((r) => Object.values(r.branchTags ?? {})).filter((t) => t === id).length
          }
        />
        <h3>Custom tags</h3>
        <WorktreeTagsEditor
          description="Extra tags that can be toggled on and off individually per worktree's branch, alongside its workflow tag. Deleting a tag removes it from every branch using it."
          tags={customTags}
          onChange={setCustomTags}
          live={live}
          usesOf={(id) =>
            repositories
              .flatMap((r) => Object.values(r.branchCustomTags ?? {}))
              .filter((ids) => ids.includes(id)).length
          }
        />
        <h3>Terminal quick buttons</h3>
        <QuickButtonsEditor
          description="Buttons shown under every worktree agent terminal. Clicking one fills the terminal's input with the text and submits it."
          buttons={terminalButtons}
          onChange={updateButtons}
          live={live}
        />
        <h3>Session system prompt</h3>
        <div className="settings-row">
          <span className="settings-label">
            <span className="settings-desc">
              Appended to the system prompt of every worktree session, after its session
              type&apos;s prompt (--append-system-prompt). Not used by the global session.
              Takes effect the next time each session starts or resumes.
            </span>
          </span>
        </div>
        <div className="settings-row">
          {live ? (
            <textarea
              className="quick-btn-text-input"
              rows={6}
              placeholder="e.g. Run the unit tests before saying a change is done"
              defaultValue={sessionSystemPrompt}
              onBlur={(e) => {
                setSessionSystemPrompt(e.target.value)
              }}
            />
          ) : (
            <SettingText
              live={false}
              rows={6}
              className="quick-btn-text-input session-prompt-input"
              placeholder="e.g. Run the unit tests before saying a change is done"
              value={sessionSystemPrompt}
              onCommit={setSessionSystemPrompt}
            />
          )}
        </div>
        <h3>Global system prompt</h3>
        <div className="settings-row">
          <span className="settings-label">
            <span className="settings-desc">
              Appended to the global session&apos;s system prompt (--append-system-prompt).
              Takes effect the next time the session starts, e.g. after restarting the app or
              starting a new conversation.
            </span>
          </span>
        </div>
        <div className="settings-row">
          {live ? (
            <textarea
              className="quick-btn-text-input"
              rows={6}
              placeholder="e.g. Prefer starting Review sessions for finished worktrees"
              defaultValue={globalSystemPrompt}
              onBlur={(e) => {
                setGlobalSystemPrompt(e.target.value)
              }}
            />
          ) : (
            <SettingText
              live={false}
              rows={6}
              className="quick-btn-text-input"
              placeholder="e.g. Prefer starting Review sessions for finished worktrees"
              value={globalSystemPrompt}
              onCommit={setGlobalSystemPrompt}
            />
          )}
        </div>
        <h3>Global quick buttons</h3>
        <QuickButtonsEditor
          description="Buttons shown under the global terminal at the bottom of the window."
          buttons={globalTerminalButtons}
          onChange={updateGlobalButtons}
          live={live}
        />
        <h3>Session types</h3>
        <div className="settings-row">
          <span className="settings-label">
            <span className="settings-desc">
              Offered when clicking + to start a new session. The session is named after
              the type and its system prompt is appended to the agent&apos;s system prompt.
              An optional first message is sent when the session starts.
            </span>
          </span>
        </div>
        {sessionTypes.map((type) => (
          <div key={type.id} className="quick-btn-row">
            <ImagePicker
              image={type.icon}
              onChange={(icon) => patchSessionType(type.id, { icon })}
              limits={SESSION_ICON_LIMITS}
              title="Choose a PNG icon"
            />
            <SettingText
              live={live}
              className="quick-btn-label-input"
              placeholder="Name, e.g. Review"
              value={type.name}
              onCommit={(name) => patchSessionType(type.id, { name })}
            />
            <div className="session-type-fields">
              <SettingText
                live={live}
                rows={6}
                className="quick-btn-text-input"
                placeholder="System prompt, e.g. how the agent should approach reviewing"
                value={type.systemPrompt}
                onCommit={(systemPrompt) => patchSessionType(type.id, { systemPrompt })}
              />
              <SettingText
                live={live}
                rows={2}
                className="quick-btn-text-input"
                placeholder="First message (optional), e.g. /trek-review"
                value={type.initialMessage ?? ''}
                onCommit={(initialMessage) => patchSessionType(type.id, { initialMessage })}
              />
              <label className="llm-inline-check">
                <input
                  type="checkbox"
                  checked={!type.llm}
                  onChange={(e) =>
                    patchSessionType(type.id, {
                      llm: e.target.checked ? undefined : serverWindow ? (serverDefault ?? { provider: 'claude' }) : defaultSessionLlm()
                    })
                  }
                />
                Use the default agent
              </label>
              {type.llm && (
                <LlmPicker value={type.llm} onChange={(llm) => patchSessionType(type.id, { llm })} {...picker} />
              )}
            </div>
            <button
              className="quick-btn-remove"
              title="Remove session type"
              onClick={() => updateSessionTypes(sessionTypes.filter((t) => t.id !== type.id))}
            >
              ×
            </button>
          </div>
        ))}
        <div className="settings-row">
          <button
            className="btn btn-ghost"
            onClick={() =>
              updateSessionTypes([
                ...sessionTypes,
                { id: crypto.randomUUID(), name: '', systemPrompt: '' }
              ])
            }
          >
            + Add session type
          </button>
        </div>
        {sections.environments !== 'hidden' && (
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
                        live={live}
                        value={envSettings.cpu ?? ENV_DEFAULTS.cpu}
                        fallback={ENV_DEFAULTS.cpu}
                        onCommit={(cpu) => updateEnv({ cpu })}
                      />
                    </label>
                    <label>
                      Memory GiB
                      <SettingNumber
                        min={1}
                        live={live}
                        value={envSettings.memory ?? ENV_DEFAULTS.memory}
                        fallback={ENV_DEFAULTS.memory}
                        onCommit={(memory) => updateEnv({ memory })}
                      />
                    </label>
                    <label>
                      Disk GiB
                      <SettingNumber
                        min={5}
                        live={live}
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
                    key={settingsRepo?.id}
                    live={live}
                    className="settings-select"
                    placeholder={ENV_DEFAULTS.composeFile}
                    value={envSettings.composeFile ?? ''}
                    onCommit={(text) => updateEnv({ composeFile: text || undefined })}
                  />
                </div>
                {orphans.length > 0 && (
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
        )}
      </div>
    </div>
  )
}

interface QuickButtonsEditorProps {
  description: string
  buttons: TerminalQuickButton[]
  onChange: (buttons: TerminalQuickButton[]) => void
  /** Text commits on every keystroke (a file window), else on blur */
  live: boolean
}

function QuickButtonsEditor({
  description,
  buttons,
  onChange,
  live
}: QuickButtonsEditorProps): React.JSX.Element {
  const patchButton = (id: string, patch: Partial<TerminalQuickButton>): void => {
    onChange(buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  }

  const moveButton = (index: number, delta: number): void => {
    const next = [...buttons]
    const [btn] = next.splice(index, 1)
    next.splice(index + delta, 0, btn)
    onChange(next)
  }

  return (
    <>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-desc">{description}</span>
        </span>
      </div>
      {buttons.map((btn, i) => (
        <div key={btn.id} className="quick-btn-row">
          <SettingText
            live={live}
            className="quick-btn-label-input"
            placeholder="Label"
            value={btn.label}
            onCommit={(label) => patchButton(btn.id, { label })}
          />
          <SettingText
            live={live}
            rows={1}
            className="quick-btn-text-input"
            placeholder="Text typed into the terminal and submitted"
            value={btn.text}
            onCommit={(text) => patchButton(btn.id, { text })}
          />
          <button
            className="quick-btn-remove"
            title="Move up"
            disabled={i === 0}
            onClick={() => moveButton(i, -1)}
          >
            ↑
          </button>
          <button
            className="quick-btn-remove"
            title="Move down"
            disabled={i === buttons.length - 1}
            onClick={() => moveButton(i, 1)}
          >
            ↓
          </button>
          <button
            className="quick-btn-remove"
            title="Remove button"
            onClick={() => onChange(buttons.filter((b) => b.id !== btn.id))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="settings-row">
        <button
          className="btn btn-ghost"
          onClick={() => onChange([...buttons, { id: crypto.randomUUID(), label: '', text: '' }])}
        >
          + Add button
        </button>
      </div>
    </>
  )
}

const NEW_TAG_COLOR = '#5dabef'

function WorktreeTagsEditor({
  description,
  tags,
  onChange,
  live,
  usesOf
}: {
  description: string
  tags: WorktreeTag[]
  onChange: (tags: WorktreeTag[]) => void
  /** Text commits on every keystroke (a file window), else on blur */
  live: boolean
  /** How many branches carry the tag */
  usesOf: (id: string) => number
}): React.JSX.Element {
  const update = (next: WorktreeTag[]): void => {
    onChange(next)
  }

  const patchTag = (id: string, patch: Partial<WorktreeTag>): void => {
    update(tags.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  const moveTag = (index: number, delta: number): void => {
    const next = [...tags]
    const [tag] = next.splice(index, 1)
    next.splice(index + delta, 0, tag)
    update(next)
  }

  const removeTag = async (tag: WorktreeTag): Promise<void> => {
    const uses = usesOf(tag.id)
    if (uses > 0) {
      const ok = await window.api.confirm({
        title: 'Delete tag',
        message: `Delete the tag "${tag.name}"?`,
        detail: `It is set on ${uses} branch${uses === 1 ? '' : 'es'}, which will lose it.`,
        confirmLabel: 'Delete'
      })
      if (!ok) return
    }
    update(tags.filter((t) => t.id !== tag.id))
  }

  return (
    <>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-desc">{description}</span>
        </span>
      </div>
      {tags.map((tag, i) => (
        <div key={tag.id} className="quick-btn-row tag-edit-row">
          <input
            className="tag-color-input"
            type="color"
            title="Tag color"
            value={tag.color}
            onChange={(e) => patchTag(tag.id, { color: e.target.value })}
          />
          <SettingText
            live={live}
            className="quick-btn-text-input"
            placeholder="Tag name"
            value={tag.name}
            onCommit={(name) => patchTag(tag.id, { name })}
          />
          <button
            className="quick-btn-remove"
            title="Move up"
            disabled={i === 0}
            onClick={() => moveTag(i, -1)}
          >
            ↑
          </button>
          <button
            className="quick-btn-remove"
            title="Move down"
            disabled={i === tags.length - 1}
            onClick={() => moveTag(i, 1)}
          >
            ↓
          </button>
          <button className="quick-btn-remove" title="Delete tag" onClick={() => void removeTag(tag)}>
            ×
          </button>
        </div>
      ))}
      <div className="settings-row">
        <button
          className="btn btn-ghost"
          onClick={() =>
            update([...tags, { id: crypto.randomUUID(), name: '', color: NEW_TAG_COLOR }])
          }
        >
          + Add tag
        </button>
      </div>
    </>
  )
}
