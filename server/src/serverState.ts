// Builds the `server` topic from the config and republishes it whenever the
// config changes (RPC edits, or CLI edits picked up by the file watch).
import type { AttentionTopic, ServerTopic } from '../../src/shared/model/topics'
import type { TrekServerConfig } from './config'
import type { ConfigStore } from './configStore'
import type { TopicHub } from './topicHub'

export function serverTopic(config: TrekServerConfig, version: string): ServerTopic {
  return {
    server: { serverId: config.serverId ?? '', name: config.name ?? '', version, health: [] },
    // Phase 2b fills this from the project store.
    projects: [],
    repos: config.repos.map(({ id, name, path }) => ({ id, name, path }))
  }
}

/** Publishes `server` and `attention` now and keeps `server` current. Returns a stop function. */
export function publishServerState(store: ConfigStore, hub: TopicHub, version: string): () => void {
  hub.publish('server', serverTopic(store.config, version))
  // Phase 2d computes attention from sessions.
  const attention: AttentionTopic = { entries: [] }
  hub.publish('attention', attention)
  const onChange = (): void => hub.publish('server', serverTopic(store.config, version))
  store.on('change', onChange)
  return () => store.off('change', onChange)
}
