// Structural diff producing the RFC 6902 subset that jsonPatch.ts applies, so a
// server can publish a new snapshot and send subscribers only what changed.
// Objects are diffed key by key; same-length arrays index by index; anything
// else that differs is replaced whole. Keys whose value is undefined count as
// absent (JSON drops them). applyPatch(a, diffJson(a, b)) deep-equals b.
// No runtime imports beyond jsonPatch.ts.
import { formatPointer, type PatchOp } from './jsonPatch.ts'

type Obj = Record<string, unknown>

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function definedKeys(o: Obj): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined)
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isObject(a) && isObject(b)) {
    const ak = definedKeys(a)
    const bk = definedKeys(b)
    return ak.length === bk.length && ak.every((k) => b[k] !== undefined && deepEqual(a[k], b[k]))
  }
  return false
}

export function diffJson(a: unknown, b: unknown): PatchOp[] {
  const ops: PatchOp[] = []
  walk(a, b, [], ops)
  return ops
}

function walk(a: unknown, b: unknown, path: string[], ops: PatchOp[]): void {
  if (deepEqual(a, b)) return
  if (isObject(a) && isObject(b)) {
    for (const k of definedKeys(a)) {
      if (b[k] === undefined) ops.push({ op: 'remove', path: formatPointer([...path, k]) })
    }
    for (const k of definedKeys(b)) {
      if (a[k] === undefined) ops.push({ op: 'add', path: formatPointer([...path, k]), value: b[k] })
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
