// Input checks shared by the v2 handlers and the project validators. Every
// failure is a BAD_REQUEST codedError (CONFLICT for a failed `expected` guard).
import { isAbsolute } from 'node:path'
import { deepEqual } from '../../src/shared/sync/jsonDiff.ts'
import { codedError } from './errors.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw bad(`${field} is required`)
  return value
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw bad(`${field} must be a string`)
  return value
}

/** A display name: trimmed, not empty. */
export function requireName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw bad(`${field} must not be empty`)
  return value.trim()
}

export function optionalName(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireName(value, field)
}

export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw bad(`${field} must be an array of strings`)
  }
  return value
}

export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw bad(`${field} must be an object`)
  return value
}

export function requireAbsolutePath(value: unknown, field: string): string {
  const path = requireString(value, field)
  if (!isAbsolute(path)) throw bad(`${field} must be an absolute path`)
  return path
}

/**
 * Throws BAD_REQUEST, naming the path, if any object nested in `value` (arrays
 * included) has an own `__proto__` key: clients cannot apply a patch at one,
 * and the JSON diff throws when it walks one.
 */
export function assertNoProtoKeys(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoProtoKeys(v, `${where}[${i}]`))
  } else if (typeof value === 'object' && value !== null) {
    if (Object.hasOwn(value, '__proto__')) throw bad(`${where} must not have a "__proto__" key`)
    for (const [key, v] of Object.entries(value)) assertNoProtoKeys(v, `${where}.${key}`)
  }
}

/** Branch names key `branchData`; `__proto__` cannot be patched on clients. */
export function requireBranch(value: unknown): string {
  const branch = requireString(value, 'branch')
  if (branch === '__proto__') throw bad('branch must not be "__proto__"')
  return branch
}

/**
 * Compare-and-set guard: when `expected` is given, the field's current value
 * must deep-equal it. null and undefined both mean "absent".
 */
export function checkExpected(field: string, current: unknown, expected: unknown): void {
  if (expected === undefined) return
  if (!deepEqual(current ?? null, expected ?? null)) {
    throw codedError('CONFLICT', `${field} changed since you read it`)
  }
}
