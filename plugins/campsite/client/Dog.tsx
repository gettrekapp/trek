// The camp dog on the strip: it runs somewhere, sits a while, and runs again (dog.ts picks where).
// Click it to pet it: it stops, wags, and a heart floats up. It belongs to no session.
import { useCallback, useEffect, useRef, useState } from 'react'
import { DOG_FRAMES, DOG_GRID, DOG_SCALE, DOG_W, dogPixels, dogStart, dogTrip, type DogPose } from '../shared/dog.ts'
import { useReducedMotion } from './hooks.ts'

/** How long a petted dog stays put, wagging */
const HAPPY_MS = 1800
/** Matches the cs-heart animation */
const HEART_MS = 1000
/** The sit before its first run, and after a resize */
const SETTLE_MS = 900

interface Props {
  /** The strip's width */
  width: number
  /** The fire, when it is lit: somewhere to sit now and then */
  fireX?: number
  /** The window is hidden: it stays where it is */
  paused: boolean
}

interface At {
  x: number
  /** The transition to `x`; 0: it is there */
  runMs: number
  left: boolean
  running: boolean
}

let hearts = 0

export function Dog({ width, fireX, paused }: Props): React.JSX.Element {
  const reduced = useReducedMotion()
  const el = useRef<HTMLButtonElement | null>(null)
  const [at, setAt] = useState<At>(() => ({ x: dogStart(width), runMs: 0, left: false, running: false }))
  const [happy, setHappy] = useState(false)
  const [pets, setPets] = useState(0)
  const [floating, setFloating] = useState<number[]>([])
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  // The fire being lit or not changes where later runs go; it does not interrupt this one
  const fire = useRef(fireX)
  fire.current = fireX

  /** Stops it where it is drawn right now (mid-run too), inside the strip; returns that spot */
  const halt = useCallback((): number => {
    const node = el.current
    const stage = node?.offsetParent
    const inside = (x: number): number => Math.min(Math.max(x, 0), Math.max(0, width))
    const x = node && stage ? inside(Math.round(node.getBoundingClientRect().left - stage.getBoundingClientRect().left + DOG_W / 2)) : null
    setAt((a) => ({ ...a, x: x ?? inside(a.x), runMs: 0, running: false }))
    return x ?? dogStart(width)
  }, [width])

  // The wander: sit, run, sit, … Restarted (from a sit, where it is) by a pet, a resize, or the window coming back
  useEffect(() => {
    let from = halt()
    if (paused || reduced || width <= 0) return
    let timer: ReturnType<typeof setTimeout>
    const go = (): void => {
      const trip = dogTrip(Math.random, from, width, fire.current)
      if (trip.runMs > 0) setAt({ x: trip.x, runMs: trip.runMs, left: trip.x < from, running: true })
      timer = setTimeout(() => {
        from = trip.x
        setAt((a) => ({ ...a, x: trip.x, runMs: 0, running: false }))
        timer = setTimeout(go, trip.restMs)
      }, trip.runMs)
    }
    timer = setTimeout(go, pets > 0 ? HAPPY_MS : SETTLE_MS)
    return () => clearTimeout(timer)
  }, [halt, paused, reduced, width, pets])

  useEffect(() => {
    if (pets === 0) return
    const timer = setTimeout(() => setHappy(false), HAPPY_MS)
    return () => clearTimeout(timer)
  }, [pets])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of pending) clearTimeout(t)
      pending.clear()
    }
  }, [])

  const pet = (): void => {
    const id = ++hearts
    setHappy(true)
    setPets((n) => n + 1)
    setFloating((f) => [...f, id])
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setFloating((f) => f.filter((x) => x !== id))
    }, HEART_MS)
    timers.current.add(timer)
  }

  const pose: DogPose = at.running ? 'run' : happy ? 'happy' : 'sit'
  return (
    <button
      ref={el}
      className={`cs-dog ${pose}${at.left ? ' left' : ''}`}
      style={{ transform: `translateX(${at.x - DOG_W / 2}px)`, transitionDuration: `${at.runMs}ms` }}
      title="Pet the dog"
      aria-label="Pet the dog"
      onClick={pet}
    >
      {floating.map((id) => (
        <Heart key={id} />
      ))}
      <span className="cs-facing">
        <svg className={pose === 'run' ? 'cs-step' : undefined} width={DOG_W} height={DOG_GRID.h * DOG_SCALE} viewBox={`0 0 ${DOG_GRID.w} ${DOG_GRID.h}`} shapeRendering="crispEdges" aria-hidden="true">
          {Array.from({ length: DOG_FRAMES[pose] }, (_, f) => (
            <g key={f} className={`cs-frame cs-frame-${f}`}>
              {dogPixels(pose, f).map((r, i) => (
                <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />
              ))}
            </g>
          ))}
        </svg>
      </span>
    </button>
  )
}

/** A 7×6 pixel heart */
const HEART: readonly (readonly [number, number, number])[] = [
  [1, 0, 2],
  [4, 0, 2],
  [0, 1, 7],
  [0, 2, 7],
  [1, 3, 5],
  [2, 4, 3],
  [3, 5, 1]
]

function Heart(): React.JSX.Element {
  return (
    <svg className="cs-heart" width={14} height={12} viewBox="0 0 7 6" shapeRendering="crispEdges" aria-hidden="true">
      {HEART.map(([x, y, w]) => (
        <rect key={y * 10 + x} x={x} y={y} width={w} height={1} fill="#ff6b8a" />
      ))}
    </svg>
  )
}
