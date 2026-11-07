// Type-level checks for TopicMirror, run by `npm run typecheck`. Never executed or imported.
import type { AttentionTopic, ProjectTopic, ServerTopic } from '../model/topics.ts'
import type { TopicState } from '../sync/topicState.ts'
import type { ClientError } from './connection.ts'
import type { TopicMirror } from './mirror.ts'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function assertType<T extends true>(): T | void {}

export function checks(mirror: TopicMirror): void {
  mirror.subscribe('server', (u) => {
    if ('error' in u) assertType<Equal<typeof u.error, ClientError>>()
    else assertType<Equal<typeof u.snapshot, ServerTopic>>()
  })
  mirror.subscribe('attention', (u) => {
    if (!('error' in u)) assertType<Equal<typeof u.snapshot, AttentionTopic>>()
  })
  mirror.subscribe('project:p1', (u) => {
    if (!('error' in u)) assertType<Equal<typeof u.snapshot, ProjectTopic>>()
  })
  assertType<Equal<ReturnType<typeof mirror.get<'server'>>, TopicState<ServerTopic> | undefined>>()
  const s = mirror.get('server')
  if (s) assertType<Equal<typeof s.snapshot.repos, ServerTopic['repos']>>()
  assertType<Equal<ReturnType<typeof mirror.whenRev<'project:p1'>>, Promise<TopicState<ProjectTopic>>>>()
}
