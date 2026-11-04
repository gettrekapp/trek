// The RFC 6902 subset carried by protocol v2 `state.patch` events: add, remove,
// replace. Copy-on-write: the input is never mutated and untouched subtrees are
// shared, so UI stores can compare by reference. No runtime imports.

export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }

export class PatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchError'
  }
}

/** RFC 6901 pointer → reference tokens. */
export function parsePointer(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) throw new PatchError(`Bad JSON pointer: ${path}`)
  return path
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
}

/** Reference tokens → RFC 6901 pointer. */
export function formatPointer(tokens: readonly string[]): string {
  return tokens.map((t) => '/' + t.replace(/~/g, '~0').replace(/\//g, '~1')).join('')
}

type Container = Record<string, unknown> | unknown[]

function isContainer(v: unknown): v is Container {
  return typeof v === 'object' && v !== null
}

function arrayIndex(arr: readonly unknown[], token: string, allowEnd: boolean, path: string): number {
  if (allowEnd && token === '-') return arr.length
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new PatchError(`Bad array index in ${path}`)
  const i = Number(token)
  if (i > (allowEnd ? arr.length : arr.length - 1)) {
    throw new PatchError(`Array index out of range in ${path}`)
  }
  return i
}

function applyAt(node: unknown, tokens: readonly string[], op: PatchOp): unknown {
  if (tokens.length === 0) {
    if (op.op === 'remove') throw new PatchError('Cannot remove the document root')
    return op.value
  }
  if (!isContainer(node)) throw new PatchError(`Path not found: ${op.path}`)
  const [head, ...rest] = tokens
  if (head === '__proto__' || head === 'constructor' || head === 'prototype') {
    throw new PatchError(`Forbidden key in ${op.path}`)
  }

  if (Array.isArray(node)) {
    const copy = node.slice()
    if (rest.length === 0) {
      if (op.op === 'add') copy.splice(arrayIndex(node, head, true, op.path), 0, op.value)
      else if (op.op === 'remove') copy.splice(arrayIndex(node, head, false, op.path), 1)
      else copy[arrayIndex(node, head, false, op.path)] = op.value
      return copy
    }
    const i = arrayIndex(node, head, false, op.path)
    copy[i] = applyAt(node[i], rest, op)
    return copy
  }

  const has = Object.prototype.hasOwnProperty.call(node, head)
  if (rest.length === 0) {
    if (op.op !== 'add' && !has) throw new PatchError(`Path not found: ${op.path}`)
    const copy: Record<string, unknown> = { ...node }
    if (op.op === 'remove') delete copy[head]
    else copy[head] = op.value
    return copy
  }
  if (!has) throw new PatchError(`Path not found: ${op.path}`)
  return { ...node, [head]: applyAt(node[head], rest, op) }
}

/**
 * Applies `ops` in order. Throws PatchError on any bad op, in which case the
 * caller's document is untouched (nothing is mutated).
 */
export function applyPatch<T>(doc: T, ops: readonly PatchOp[]): T {
  let out: unknown = doc
  for (const op of ops) {
    if (op.op !== 'add' && op.op !== 'remove' && op.op !== 'replace') {
      throw new PatchError(`Unsupported op: ${(op as { op: unknown }).op}`)
    }
    out = applyAt(out, parsePointer(op.path), op)
  }
  return out as T
}
