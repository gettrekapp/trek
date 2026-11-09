// What each tick of the environments' poll (useEnvironmentPoll) does. Pure, for the tests.
import type { EnvCheckResult } from '../../shared/types'

/** A failed tool check is asked again every this many ticks (a minute at the poll's 10 s). */
export const ENV_RECHECK_TICKS = 6

/**
 * `tick` counts from 1. Until the tool check answers, each tick asks it; once it has failed
 * (colima or docker missing on the server), every ENV_RECHECK_TICKS-th tick asks again, so a tool
 * installed meanwhile is picked up (the server keeps only an `ok` answer); otherwise the tick lists
 * the environments (refreshEnvironments, a no-op until a check has passed).
 */
export function envPollTick(check: Pick<EnvCheckResult, 'ok'> | null, tick: number): 'check' | 'list' {
  if (check === null) return 'check'
  if (!check.ok && tick % ENV_RECHECK_TICKS === 0) return 'check'
  return 'list'
}
