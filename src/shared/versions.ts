// Version comparison for the app's updater, the Local server supervisor and trek-server's updater.

/** -1, 0 or 1, comparing dotted numbers part by part; a part that is not a number counts as 0. A prerelease part is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split('-')[0].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : 0))
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}
