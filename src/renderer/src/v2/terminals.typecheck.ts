// Type-level checks for the server-window terminal API, run by `npm run typecheck`. Never executed or imported.
import type { PtyStream } from '../../../shared/client/index.ts'
import type { Project } from '../../../shared/model/types'
import type { disposeV2Terminals, retryV2Terminals, syncV2Terminals } from '../terminals'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function assertType<T extends true>(): T | void {}

export function checks(): void {
  assertType<Equal<typeof syncV2Terminals, (project: Project, ptys: PtyStream) => void>>()
  assertType<Equal<typeof disposeV2Terminals, () => void>>()
  assertType<Equal<typeof retryV2Terminals, () => void>>()
}
