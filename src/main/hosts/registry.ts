import type { HostService } from './HostService'
import { LocalHost } from './LocalHost'
import type { RemoteHost } from './RemoteHost'

export const localHost = new LocalHost()

const remoteHosts = new Map<string, RemoteHost>()

/**
 * Which host owns each live pty — lets pty:write/resize/dispose keep their
 * id-only signatures (the renderer never passes serverId on the hot path).
 */
const ptyOwners = new Map<string, HostService>()

export function getHost(serverId: string | null | undefined): HostService {
  if (!serverId) return localHost
  const host = remoteHosts.get(serverId)
  if (!host) throw new Error(`Unknown server: ${serverId}`)
  return host
}

export function getRemoteHost(serverId: string): RemoteHost | undefined {
  return remoteHosts.get(serverId)
}

export function setRemoteHost(serverId: string, host: RemoteHost): void {
  remoteHosts.set(serverId, host)
}

export function deleteRemoteHost(serverId: string): void {
  remoteHosts.delete(serverId)
}

export function allRemoteHosts(): RemoteHost[] {
  return [...remoteHosts.values()]
}

export function setPtyOwner(id: string, host: HostService): void {
  ptyOwners.set(id, host)
}

export function getPtyOwner(id: string): HostService | undefined {
  return ptyOwners.get(id)
}

export function deletePtyOwner(id: string): void {
  ptyOwners.delete(id)
}
