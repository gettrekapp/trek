// How a server window learns that its project was deleted. Pure.
import { CAPABILITY } from '../../../shared/protocolV2.ts'
import { errorCode } from './errors.ts'

/**
 * The project topic's error means the project is gone for good: the server
 * said the topic ended (`topic.ended`, a delete while subscribed), or a
 * subscribe found no such project (a reload after the delete).
 */
export function projectGone(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'NOT_FOUND' || code === 'TOPIC_ENDED'
}

/**
 * A server older than `topicEnd` drops a deleted project's topic silently: the
 * only signal is its `server` topic no longer listing the project, so the
 * window watches that topic, for such a server only. Read at each connect,
 * from the welcome.
 */
export function watchesServerTopic(capabilities: readonly string[]): boolean {
  return !capabilities.includes(CAPABILITY.topicEnd)
}
