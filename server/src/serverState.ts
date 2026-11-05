// Builds the `server` topic from the config, the project list and health, and
// republishes it whenever any of them changes.
import type { AttentionTopic, ServerTopic } from '../../src/shared/model/topics'
import type { HealthWarning, ProjectSummary } from '../../src/shared/model/types'
import type { TrekServerConfig } from './config'
import type { ConfigStore } from './configStore'
import type { TopicHub } from './topicHub'

export interface ServerStateSources {
  projects: () => ProjectSummary[]
  health: () => HealthWarning[]
}

export function serverTopic(
  config: TrekServerConfig,
  version: string,
  projects: ProjectSummary[],
  health: HealthWarning[]
): ServerTopic {
  return {
    server: { serverId: config.serverId ?? '', name: config.name ?? '', version, health },
    projects,
    repos: config.repos.map(({ id, name, path }) => ({ id, name, path }))
  }
}

/**
 * Publishes `server` and `attention` now and keeps `server` current on config
 * changes. Call `refresh()` when projects or health change.
 */
export function publishServerState(
  store: ConfigStore,
  hub: TopicHub,
  version: string,
  sources: ServerStateSources
): { refresh: () => void; stop: () => void } {
  const refresh = (): void => hub.publish('server', serverTopic(store.config, version, sources.projects(), sources.health()))
  refresh()
  // Phase 2d computes attention from sessions.
  const attention: AttentionTopic = { entries: [] }
  hub.publish('attention', attention)
  store.on('change', refresh)
  return { refresh, stop: () => store.off('change', refresh) }
}
