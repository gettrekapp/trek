// Input checks shared by the v2 handlers and the project validators. Every
// failure is a BAD_REQUEST (or PATH_DENIED) codedError.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
