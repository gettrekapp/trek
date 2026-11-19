// One hiker as crisp SVG pixels. Two-frame poses draw both frames and CSS alternates them;
// motion (bob, wave, hop, breathe) is CSS too, and reduced motion stills it (campsite.css).
import { memo } from 'react'
import type { Gear, Look } from '../shared/hiker.ts'
import { FRAMES, pixels, type Pose } from '../shared/pixels.ts'
import { SIGN_COLORS, SIGN_GLYPHS, type Sign } from '../shared/pose.ts'

const MOTION: Partial<Record<Pose, string>> = {
  stand: 'cs-bob',
  map: 'cs-bob',
  wave: 'cs-wave',
  cheer: 'cs-hop',
  sleep: 'cs-breathe',
  walk: 'cs-step'
}

interface Props {
  look: Look
  pose: Pose
  gear?: Gear | 'none'
  /** Pixel size: 1 on a tab, 3 at camp and in the terminal corner */
  scale: number
  label: string
  grey?: boolean
  /** Drawn over the head. Not at scale 1: a tab has no room above, so its indicator shows a chip instead */
  sign?: Sign | null
  /** Hidden from assistive tech: its container already says who it is (a session tab) */
  decorative?: boolean
}

export const Hiker = memo(function Hiker({ look, pose, gear, scale, label, grey = false, sign = null, decorative = false }: Props): React.JSX.Element {
  const frames = FRAMES[pose]
  return (
    <svg
      className={`cs-hiker ${MOTION[pose] ?? ''}${grey ? ' cs-grey' : ''}`}
      width={12 * scale}
      height={16 * scale}
      viewBox="0 0 12 16"
      shapeRendering="crispEdges"
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
    >
      {sign && scale > 1 && (
        // A 5×7 board over the head; its glyph on a 3×5 grid, one unit in from each edge
        <g className="cs-sign">
          <rect x={3.5} y={-8} width={5} height={7} style={{ fill: SIGN_COLORS[sign] }} />
          {SIGN_GLYPHS[sign].map(([x, y]) => (
            <rect key={`${x},${y}`} x={4.5 + x} y={-7 + y} width={1} height={1} fill="#111113" />
          ))}
        </g>
      )}
      {Array.from({ length: frames }, (_, f) => (
        <g key={f} className={frames === 2 ? `cs-frame cs-frame-${f}` : undefined}>
          {pixels(look, pose, f, gear).map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />
          ))}
        </g>
      ))}
    </svg>
  )
})
