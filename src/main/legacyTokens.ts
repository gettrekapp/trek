// The v1 (per-project) server tokens an older Trek saved in server-tokens.json, read only by the
// importer (4d Note 6): it stays until the import is retired, not with file windows.
import { createSecretStore } from './secrets'
import { adoptableToken, decodeTokenRecord } from './serverTokenRules'

const tokens = createSecretStore('server-tokens.json')

/**
 * The v1 token stored for the legacy server `serverId`, when it was entered for `entryUrl`'s
 * origin (adoptableToken). Never returned over IPC.
 */
export async function legacyTokenFor(serverId: string, entryUrl: string): Promise<string | null> {
  const raw = await tokens.get(serverId)
  return adoptableToken(entryUrl, raw === null ? null : decodeTokenRecord(raw))
}
