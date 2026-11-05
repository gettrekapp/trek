// Protocol v2 request dispatch. Phase 2a serves the handshake topics and the
// repo registry; later sub-plans add the rest of MethodParamsV2.
import { parseTopic } from '../../src/shared/model/topics.ts'
import type { WireError } from '../../src/shared/protocol'
import type { ConfigStore } from './configStore'
import { codedError, toWireError } from './errors.ts'
import type { Subscriber, TopicHub } from './topicHub'

export interface V2Context {
  store: ConfigStore
  hub: TopicHub
  /** This connection, as a topic subscriber */
  subscriber: Subscriber
}

type Handler = (params: any, ctx: V2Context) => unknown

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw codedError('BAD_REQUEST', `${field} is required`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw codedError('BAD_REQUEST', `${field} must be a string`)
  return value
}

const handlers: Record<string, Handler> = {
  'sys.ping': (p) => ({ t: p.t }),

  'project.list': () => [],

  'sub.subscribe': (p, ctx) => {
    if (!parseTopic(p.topic)) throw codedError('BAD_REQUEST', `Unknown topic: ${String(p.topic)}`)
    const state = ctx.hub.subscribe(p.topic, ctx.subscriber)
    if (!state) throw codedError('NOT_FOUND', `No such topic: ${p.topic}`)
    return state
  },

  'sub.unsubscribe': (p, ctx) => {
    ctx.hub.unsubscribe(p.topic, ctx.subscriber)
    return null
  },

  'server.addRepo': (p, ctx) => {
    const path = requireString(p.path, 'path')
    const name = optionalString(p.name, 'name')
    const { repo } = ctx.store.addRepo(path, { name, requireAllowedRoot: true })
    return { repoId: repo.id }
  },

  'server.removeRepo': (p, ctx) => {
    const repoId = requireString(p.repoId, 'repoId')
    // By id only: the CLI's path fallback is not offered over the wire.
    if (!ctx.store.config.repos.some((r) => r.id === repoId)) {
      throw codedError('NOT_FOUND', `No repo with id "${repoId}"`)
    }
    ctx.store.removeRepo(repoId)
    return null
  }
}

export async function dispatchV2(
  method: string,
  params: unknown,
  ctx: V2Context
): Promise<{ ok: true; result: unknown } | { ok: false; error: WireError }> {
  const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
  if (!handler) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown method: ${method}` } }
  }
  try {
    return { ok: true, result: await handler(params ?? {}, ctx) }
  } catch (err) {
    return { ok: false, error: toWireError(method, err) }
  }
}
