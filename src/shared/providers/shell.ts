/** Single-quote a value for a POSIX shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Trim each part, drop the empty ones, join with spaces. */
export function joinCommand(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
}
