import type { ProjectFile } from './types'

type AppearanceFields = Pick<ProjectFile, 'titleBarColor' | 'logoImage' | 'bannerImage'>

/** The top bar's background when a project hasn't set a color (matches .title-bar). */
export const DEFAULT_TITLE_BAR_COLOR = '#161618'

function isHexColor(value: unknown): boolean {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

function isEmbeddedImage(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('data:image/')
}

/**
 * Drops invalid appearance values from a loaded project. Project files can be shared or
 * hand-edited, and a remote image URL would make Trek fetch it on open.
 */
export function sanitizeAppearance<T extends AppearanceFields>(project: T): T {
  const clean = { ...project }
  if (!isHexColor(clean.titleBarColor)) delete clean.titleBarColor
  if (!isEmbeddedImage(clean.logoImage)) delete clean.logoImage
  if (!isEmbeddedImage(clean.bannerImage)) delete clean.bannerImage
  return clean
}

/** The name a rename should leave: trimmed, or the current one if the input is blank. */
export function resolveProjectName(input: string, current: string): string {
  return input.trim() || current
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Which text is more readable on a #rrggbb color, by WCAG contrast ratio. */
export function titleBarForeground(color: string): 'light' | 'dark' {
  const luminance = relativeLuminance(color)
  const contrastWithWhite = 1.05 / (luminance + 0.05)
  const contrastWithBlack = (luminance + 0.05) / 0.05
  return contrastWithWhite >= contrastWithBlack ? 'light' : 'dark'
}
