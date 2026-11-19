// One hiker as crisp SVG pixels. Two-frame poses draw both frames and CSS alternates them;
// motion (bob, wave, hop, breathe) is CSS too, and reduced motion stills it (campsite.css).
import { memo } from 'react'
import type { Gear, Look } from '../shared/hiker.ts'
import { FRAMES, pixels, type Pose } from '../shared/pixels.ts'

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
  /** Pixel size: 1 on a tab, 2.5 at camp, 3 in the terminal corner */
  scale: number
  label: string
  grey?: boolean
  sign?: boolean
  /** Hidden from assistive tech: its container already says who it is (a session tab) */
  decorative?: boolean
}

export const Hiker = memo(function Hiker({ look, pose, gear, scale, label, grey = false, sign = false, decorative = false }: Props): React.JSX.Element {
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
      {sign && (
        <g className="cs-sign">
          <rect x={4} y={-6} width={4} height={5} fill="#ffb020" />
          <rect x={5.5} y={-5} width={1} height={2} fill="#111111" />
          <rect x={5.5} y={-2.5} width={1} height={0.8} fill="#111111" />
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
