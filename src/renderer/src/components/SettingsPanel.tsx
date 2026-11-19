import { useEffect, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '../store'
import { PluginsSettings, hasPluginSettings } from '../plugins/PluginsSettings'
import { usePluginEntries } from '../plugins/PluginHost'
import type { PluginSelection } from '../plugins/pluginsTab'
import { getBackend, subscribeBackend, type WindowBackend } from '../backend'
import { settingsSections } from '../backendFeatures'
import { useFeatures } from '../useFeatures'
import { nextSettingsTab, resolveSettingsTab, visibleSettingsTabs, type SettingsTabId } from '../settingsTabs'
import { GeneralTab } from './settings/GeneralTab'
import { AgentsTab } from './settings/AgentsTab'
import { SessionsTab } from './settings/SessionsTab'
import { WorktreesTab } from './settings/WorktreesTab'
import { EnvironmentsTab } from './settings/EnvironmentsTab'
import { RepoSelector } from './settings/RepoSelector'
import { PluginRepoSettings, usePluginSettingsTabs } from '../plugins/WorktreeSlots'

interface Props {
  visible: boolean
}

const tabDomId = (id: SettingsTabId): string => `settings-tab-${id}`

export function SettingsPanel({ visible }: Props): React.JSX.Element {
  // The project's settings are edited on the server: text is committed on blur (each commit is a
  // request, and leaving a tab blurs), the environments show where the window's server has them
  // (its VMs are the server's), the plugins where it has them (PluginsSettings), and a conflict's
  // Reload remounts the tab on screen.
  const features = useFeatures()
  const sections = settingsSections(features)
  const reload = useAppStore((s) => s.settingsReload)
  const pluginEntries = usePluginEntries()
  const pluginTabs = usePluginSettingsTabs()
  // Default applied outside the selector — `?? []` inside it would return a
  // fresh array every snapshot and loop React's store re-render (error #185).
  const repositories = useAppStore((s) => s.project?.repositories) ?? []
  // Which repository the per-repository settings edit, on Worktrees and Environments alike.
  const [settingsRepoId, setSettingsRepoId] = useState<string | null>(null)
  const settingsRepo = repositories.find((r) => r.id === settingsRepoId) ?? repositories[0]
  const repoSelector = <RepoSelector repositories={repositories} repo={settingsRepo} onSelect={setSettingsRepoId} />
  // Kept while the window is open (the panel stays mounted while hidden); General in a new one.
  const [chosen, setChosen] = useState<SettingsTabId>('general')
  // The Plugins tab's selected row, kept here because the tab's panel remounts on a settings
  // reload. It belongs to the backend it was picked on: another server or project starts afresh.
  // Whether a narrow panel had that row's detail open is not kept: a reload or a return to the tab
  // shows the list, with the row still selected.
  const backend = useSyncExternalStore(subscribeBackend, getBackend)
  const [pluginPick, setPluginPick] = useState<{ backend: WindowBackend; selection: PluginSelection } | null>(null)
  const pluginSelection = pluginPick?.backend === backend ? pluginPick.selection : null
  const tabs = visibleSettingsTabs({
    environments: sections.environments !== 'hidden',
    plugins: hasPluginSettings(pluginEntries),
    pluginTabs
  })
  const active = resolveSettingsTab(chosen, tabs)
  const pluginTab = pluginTabs.find((t) => t.id === active)
  // A plugin's tab that went (the plugin switched off, or another server): General is chosen, so
  // the tab doesn't come back by itself when the plugin does.
  useEffect(() => {
    if (active !== chosen) setChosen(active)
  }, [active, chosen])

  const onTabKey = (e: React.KeyboardEvent): void => {
    const next = nextSettingsTab(tabs, active, e.key)
    if (!next) return
    e.preventDefault()
    setChosen(next)
    document.getElementById(tabDomId(next))?.focus()
  }

  return (
    <div className="settings-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="settings-tabs" role="tablist" aria-label="Settings" onKeyDown={onTabKey}>
        {tabs.map((t) => (
          <button
            key={t.id}
            id={tabDomId(t.id)}
            role="tab"
            aria-selected={t.id === active}
            aria-controls="settings-tabpanel"
            tabIndex={t.id === active ? 0 : -1}
            className={`settings-tab ${t.id === active ? 'active' : ''}`}
            onClick={() => setChosen(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings-scroll">
        <div
          className={`settings-content${active === 'plugins' ? ' settings-content-wide' : ''}`}
          id="settings-tabpanel"
          role="tabpanel"
          aria-labelledby={tabDomId(active)}
          key={`${active} ${reload}`}
        >
          {active === 'general' && <GeneralTab />}
          {active === 'agents' && <AgentsTab projectOnly={sections.agents === 'project'} />}
          {active === 'sessions' && <SessionsTab />}
          {active === 'worktrees' && <WorktreesTab repo={settingsRepo} repoSelector={repoSelector} />}
          {active === 'environments' && <EnvironmentsTab repo={settingsRepo} repoSelector={repoSelector} />}
          {active === 'plugins' && <PluginsSettings chosen={pluginSelection} onChoose={(selection) => setPluginPick({ backend, selection })} />}
          {/* A plugin's repository settings (plugins E3): core's heading and repository picker, then its own part. */}
          {pluginTab && (
            <>
              <h3>{pluginTab.label}</h3>
              {repoSelector}
              <PluginRepoSettings tab={pluginTab} repoId={settingsRepo?.id} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
