// scripts/smokeSettings.mjs — the Settings page's tabs, for the smokes: only the open tab's rows exist.

/** Opens a Settings tab by its label; `settings` is the `.settings-panel` locator. */
export async function openSettingsTab(settings, name) {
  await settings.getByRole('tab', { name, exact: true }).click()
  await settings.locator('.settings-tab.active', { hasText: name }).waitFor({ timeout: 5000 })
}

/** The labels of the tabs the page shows, in order. */
export const settingsTabNames = (settings) => settings.locator('.settings-tab').allTextContents()
