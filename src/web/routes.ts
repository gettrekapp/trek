// The web client's two routes (5c-3): the projects list at /, a project at
// /p/<id>. Pure: tests check the round trip.

/** The project a path names, or null for the projects list (any other path too). */
export function projectOfPath(pathname: string): string | null {
  const m = /^\/p\/([^/]+)\/?$/.exec(pathname)
  if (!m) return null
  try {
    const id = decodeURIComponent(m[1])
    return id ? id : null
  } catch {
    return null
  }
}

export function pathOfProject(projectId: string | null): string {
  return projectId ? `/p/${encodeURIComponent(projectId)}` : '/'
}
