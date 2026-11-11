// Per-server generations (6a): bumped when that server's connection is added or removed, so only
// the screens showing that server's topics subscribe again. Pure.

export type Generations = Readonly<Record<string, number>>

/** `gens` with each of `ids` one higher (a new object only when `ids` is not empty). */
export function bumpGenerations(gens: Generations, ids: readonly string[]): Generations {
  if (!ids.length) return gens
  const next: Record<string, number> = { ...gens }
  for (const id of ids) next[id] = (next[id] ?? 0) + 1
  return next
}
