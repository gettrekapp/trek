// scripts/smokeSettings.mjs — the Settings page's tabs, for the smokes: only the open tab's rows exist.

/** Opens a Settings tab by its label; `settings` is the `.settings-panel` locator. */
export async function openSettingsTab(settings, name) {
  await settings.getByRole('tab', { name, exact: true }).click()
  await settings.locator('.settings-tab.active', { hasText: name }).waitFor({ timeout: 5000 })
}

/**
 * The Plugins tab is a list of plugins and the selected one's detail; a narrow panel shows one of
 * the two, with `‹ Plugins` leading back to the list. Shows the list, whichever the window's width.
 */
async function showPluginList(settings) {
  const back = settings.locator('.plugins-back')
  if (await back.isVisible()) await back.click()
}

/** Selects a plugin's row on the Plugins tab: only the selected plugin's settings exist. */
export async function openPlugin(settings, id) {
  await showPluginList(settings)
  await settings.locator(`[data-plugin="${id}"] .plugins-row-main`).click()
  // Attached, not visible: a narrow panel hides the list once the row's detail opens.
  await settings.locator(`[data-plugin="${id}"].selected`).waitFor({ state: 'attached', timeout: 5000 })
}

/** A plugin's switch for the project, in the Plugins tab's list (shown first, were its detail open). */
export async function pluginSwitch(settings, id) {
  await showPluginList(settings)
  return settings.locator(`[data-plugin="${id}"] input.plugin-switch`)
}

/** The labels of the tabs the page shows, in order. */
export const settingsTabNames = (settings) => settings.locator('.settings-tab').allTextContents()
