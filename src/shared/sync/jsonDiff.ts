// Structural diff producing the RFC 6902 subset that jsonPatch.ts applies, so a
// server can publish a new snapshot and send subscribers only what changed.
// Objects are diffed key by key; same-length arrays index by index; anything
// else that differs is replaced whole. Keys whose value is undefined count as
// absent (JSON drops them); presence always means an OWN property, so names
// like `constructor` behave as ordinary keys. applyPatch(a, diffJson(a, b))
// deep-equals b.
// Snapshots must be plain JSON data: plain objects, arrays, strings, finite
// numbers, booleans and null. No Dates, NaN, undefined array elements or
// functions. Non-plain objects are compared by identity and replaced whole.
// An own `__proto__` key can never be applied by clients, so diffing one throws.
// No runtime imports beyond jsonPatch.ts.
import { formatPointer, type PatchOp } from './jsonPatch.ts'

type Obj = Record<string, unknown>

function isObject(v: unknown): v is Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function has(o: Obj, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined
}

function definedKeys(o: Obj): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined)
}

function same(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b)
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (same(a, b)) return true
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isObject(a) && isObject(b)) {
    const ak = definedKeys(a)
    const bk = definedKeys(b)
    return ak.length === bk.length && ak.every((k) => has(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

function checkKeys(keys: string[], path: string[]): void {
  if (keys.includes('__proto__')) {
    throw new Error(`Cannot diff an own "__proto__" key at ${formatPointer(path) || '(root)'}`)
  }
}

export function diffJson(a: unknown, b: unknown): PatchOp[] {
  const ops: PatchOp[] = []
  walk(a, b, [], ops)
  return ops
}

function walk(a: unknown, b: unknown, path: string[], ops: PatchOp[]): void {
  if (deepEqual(a, b)) return
  if (isObject(a) && isObject(b)) {
    const ak = definedKeys(a)
    const bk = definedKeys(b)
    checkKeys(ak, path)
    checkKeys(bk, path)
    for (const k of ak) {
      if (!has(b, k)) ops.push({ op: 'remove', path: formatPointer([...path, k]) })
    }
    for (const k of bk) {
      if (!has(a, k)) ops.push({ op: 'add', path: formatPointer([...path, k]), value: b[k] })
      else walk(a[k], b[k], [...path, k], ops)
    }
    return
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) walk(a[i], b[i], [...path, String(i)], ops)
    return
  }
  ops.push({ op: 'replace', path: formatPointer(path), value: b })
}
