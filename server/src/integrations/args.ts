// Argument checks for the docker and stack methods (phase 5a; the Colima environments' checks are
// the env plugin's since plugins E2, plugins/colima/server/args.ts). A client on another machine can
// call these, so every value that reaches a command line is checked here: nothing goes through a
// shell (every command is execFile or spawn with an argument list), and each value is limited to
// what the method needs. Every failure is BAD_REQUEST.
import type { ComposeAction, ContainerAction } from '../../../src/shared/types'
import { codedError } from '../errors.ts'
import { requireString } from '../validate.ts'

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/** A container id or name, as `docker ps` prints them. Never a leading "-": that would be a flag. */
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/

export const CONTAINER_ACTIONS: readonly ContainerAction[] = ['start', 'stop', 'restart']
export const COMPOSE_ACTIONS: readonly ComposeAction[] = ['up', 'upBuild', 'restart', 'stop', 'down', 'pull']

export function requireContainerId(value: unknown): string {
  if (typeof value !== 'string' || !CONTAINER_RE.test(value)) throw bad('id must be a container id or name')
  return value
}

export function requireContainerAction(value: unknown): ContainerAction {
  if (!(CONTAINER_ACTIONS as readonly unknown[]).includes(value)) throw bad(`action must be one of ${CONTAINER_ACTIONS.join(', ')}`)
  return value as ContainerAction
}

export function requireComposeAction(value: unknown): ComposeAction {
  if (!(COMPOSE_ACTIONS as readonly unknown[]).includes(value)) throw bad(`action must be one of ${COMPOSE_ACTIONS.join(', ')}`)
  return value as ComposeAction
}

export function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw bad(`${field} must be an integer from ${min} to ${max}`)
  }
  return value
}

export { requireString }
