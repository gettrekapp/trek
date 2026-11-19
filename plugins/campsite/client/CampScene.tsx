// The campsite strip's backdrop, "alpine dusk": stars, a crescent moon, a ridge, a treeline, the
// ground and a trail. HTML, not a stretched SVG, so pines keep their shape at any width. Colors
// and shapes are in campsite.css.

/** [left %, top px] */
const STARS: readonly (readonly [number, number])[] = [[7, 14], [16, 8], [23, 30], [34, 18], [41, 10], [55, 16], [63, 22], [74, 8], [82, 26], [96, 20]]

/** A treeline along the back, clear of the fire in the middle (nothing between 40% and 56%) */
const PINES = [1, 3.5, 6.5, 10, 14, 19, 27, 36, 59, 66, 74, 81, 86, 90, 93.5, 97].map((left, i) => {
  const height = 28 + ((i * 17) % 24)
  return { left, height, width: Math.round(height * 0.62), light: i % 2 === 1 }
})

export function CampScene(): React.JSX.Element {
  return (
    <div className="cs-scene" aria-hidden="true">
      {STARS.map(([left, top]) => (
        <i key={left} className="cs-star" style={{ left: `${left}%`, top }} />
      ))}
      <i className="cs-moon" />
      <i className="cs-ridge" />
      {PINES.map((p) => (
        <i key={p.left} className={`cs-pine${p.light ? ' light' : ''}`} style={{ left: `${p.left}%`, width: p.width, height: p.height }} />
      ))}
      <i className="cs-ground" />
      <i className="cs-trail" />
    </div>
  )
}
