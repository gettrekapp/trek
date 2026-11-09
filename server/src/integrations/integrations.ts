// The server's integrations with outside services (phase 5b): Linear, with the server's own key in
// its secrets file. Made once per server (index.ts) and handed to the handlers through V2Context.
import { createLinearService, type KeySlot, type LinearService } from '../../../src/host/linearService.ts'
import { createSecretFile, type SecretFile } from '../secrets.ts'

/** The secrets file's names. */
export const LINEAR_SECRET = 'linear'

export interface Integrations {
  linear: LinearService
}

export interface IntegrationOptions {
  /** `secrets.json` beside the server's config (secretsPathFor) */
  secretsFile: string
  /**
   * Linear's GraphQL endpoint, for tests (default api.linear.app); the server reads
   * `TREK_SERVER_LINEAR_URL` from its environment for its smokes.
   */
  linearEndpoint?: string
}

export function keySlot(file: SecretFile, name: string): KeySlot {
  return {
    get: () => file.get(name),
    set: (value) => file.set(name, value),
    setIfAbsent: (value) => file.setIfAbsent(name, value)
  }
}

export function createIntegrations(options: IntegrationOptions): Integrations {
  const secrets = createSecretFile(options.secretsFile)
  return {
    linear: createLinearService({ key: keySlot(secrets, LINEAR_SECRET), endpoint: options.linearEndpoint })
  }
}
