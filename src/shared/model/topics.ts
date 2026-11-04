// Subscription topics of protocol v2 and the snapshot each one carries.
import type { AttentionEntry, Project, ProjectSummary, ServerInfo } from './types.ts'

export type Topic = 'server' | 'attention' | `project:${string}`

/** `server`: who the server is, its health, and its projects. */
export interface ServerTopic {
  server: ServerInfo
  projects: ProjectSummary[]
}

/** `attention`: sessions in attention/done across this server's projects. */
export interface AttentionTopic {
  entries: AttentionEntry[]
}

/** `project:<id>`: the whole project tree. */
export type ProjectTopic = Project

export type TopicSnapshot<T extends Topic> = T extends 'server'
  ? ServerTopic
  : T extends 'attention'
    ? AttentionTopic
    : ProjectTopic

export type ParsedTopic =
  | { kind: 'server' }
  | { kind: 'attention' }
  | { kind: 'project'; projectId: string }

const PROJECT_PREFIX = 'project:'

export function projectTopic(projectId: string): Topic {
  return `${PROJECT_PREFIX}${projectId}`
}

/** null for anything that is not a topic (servers reply BAD_REQUEST). */
export function parseTopic(topic: unknown): ParsedTopic | null {
  if (topic === 'server') return { kind: 'server' }
  if (topic === 'attention') return { kind: 'attention' }
  if (typeof topic === 'string' && topic.startsWith(PROJECT_PREFIX)) {
    const projectId = topic.slice(PROJECT_PREFIX.length)
    if (projectId) return { kind: 'project', projectId }
  }
  return null
}
