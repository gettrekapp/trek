// A refusal from the demo server (apps/mobile/src/demo), sent as the wire error a real server would.
import type { WireErrorCode } from '../shared.ts'

export const NOT_IN_DEMO_MESSAGE = 'Not available in the demo'

export class DemoError extends Error {
  readonly code: WireErrorCode
  /** `details.reason` on the wire (e.g. `dirty`) */
  readonly reason: string | undefined
  constructor(code: WireErrorCode, message: string, reason?: string) {
    super(message)
    this.code = code
    this.reason = reason
  }
}

export const notInDemo = (): DemoError => new DemoError('BAD_REQUEST', NOT_IN_DEMO_MESSAGE)
