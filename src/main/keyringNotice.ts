// Tokens saved without a keyring (Linux without GNOME Keyring or KWallet): a one-time notice,
// remembered in userData/keyring-notice.json, and the fact for Settings (app:secretStorage).
import { app, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { onUnencryptedSave, secretStorage, writeFileAtomic } from './secrets'
import type { SecretStorageKind } from './secretsRules'

/** Set by the Linux smokes: a native dialog there would take the focus from the window they type in. */
const NOTICE_DISABLED = ['1', 'true', 'yes'].includes((process.env.TREK_NO_KEYRING_NOTICE ?? '').trim().toLowerCase())

const markerPath = (): string => join(app.getPath('userData'), 'keyring-notice.json')
let showing = false

async function showOnce(): Promise<void> {
  if (NOTICE_DISABLED || showing || existsSync(markerPath())) return
  showing = true
  try {
    await writeFileAtomic(markerPath(), JSON.stringify({ shownAt: new Date().toISOString() }))
    await dialog.showMessageBox({
      type: 'warning',
      message: 'Server tokens are stored unencrypted',
      detail:
        'This computer has no keyring that Trek can use, so the tokens Trek saves are kept unencrypted ' +
        `in ${app.getPath('userData')} (readable only by your user).\n\n` +
        'Install and unlock GNOME Keyring (gnome-keyring) or KWallet, then restart Trek: tokens saved ' +
        'from then on are encrypted.',
      buttons: ['OK']
    })
  } catch (err) {
    console.warn('trek: the keyring notice failed', err)
  } finally {
    showing = false
  }
}

/** After ready. */
export function registerKeyringNotice(): void {
  ipcMain.handle('app:secretStorage', (): SecretStorageKind => secretStorage())
  onUnencryptedSave(() => void showOnce())
}
