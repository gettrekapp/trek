// The demo server's requests (apps/mobile/src/demo): one handler per protocol method it answers.
// Anything else is refused with "Not available in the demo". scripts/mobileDemo.test.mjs checks
// that every request the phone sends is in DEMO_METHODS or NOT_IN_DEMO.
import type { MethodNameV2, MethodParamsV2, MethodResultsV2 } from '../shared.ts'
import type { DemoContext } from './demoServer.ts'
import { AUTOMATION_HANDLERS } from './handlers/automations.ts'
import { BRANCH_HANDLERS } from './handlers/branch.ts'
import { SESSION_HANDLERS } from './handlers/sessions.ts'
import { WORKTREE_HANDLERS } from './handlers/worktrees.ts'

export type DemoHandler<M extends MethodNameV2> = (ctx: DemoContext, params: MethodParamsV2[M]) => MethodResultsV2[M]
export type DemoHandlers<M extends MethodNameV2> = { [K in M]: DemoHandler<K> }

export const DEMO_HANDLERS: Partial<DemoHandlers<MethodNameV2>> = {
  ...BRANCH_HANDLERS,
  ...SESSION_HANDLERS,
  ...AUTOMATION_HANDLERS,
  ...WORKTREE_HANDLERS
}

/** Answered by the server itself (demoServer.ts) */
const CORE_METHODS = ['sys.ping', 'sub.subscribe', 'sub.unsubscribe']

/** Every method the demo answers */
export const DEMO_METHODS: string[] = [...CORE_METHODS, ...Object.keys(DEMO_HANDLERS)]

/** What the phone can send that the demo refuses ("Not available in the demo"), and why */
export const NOT_IN_DEMO: Record<string, string> = {
  'push.setGrant': 'the demo has no push capability',
  'push.clearGrant': 'the demo has no push capability',
  'push.status': 'the demo has no push capability',
  'stack.status': 'the demo has no stacks capability',
  'worktree.promote': 'the demo has no promote capability',
  'worktree.demote': 'the demo has no promote capability',
  'promote.listen': 'the demo has no promote capability',
  'promote.claim': 'the demo has no promote capability',
  'promote.answer': 'the demo has no promote capability'
}
