// The campsite strip's night backdrop: sky, stars, moon, treeline, ground. Stretches to the strip.
export function CampScene(): React.JSX.Element {
  return (
    <svg className="cs-scene" viewBox="0 0 600 110" preserveAspectRatio="none" aria-hidden="true">
      <rect width={600} height={110} fill="#121726" />
      <circle cx={80} cy={18} r={1} fill="#ffffff" />
      <circle cx={190} cy={10} r={1} fill="#ffffff" />
      <circle cx={330} cy={22} r={1} fill="#ffffff" />
      <circle cx={420} cy={14} r={1} fill="#ffffff" />
      <circle cx={520} cy={26} r={1} fill="#ffffff" />
      <circle cx={560} cy={16} r={8} fill="#e8e4d0" />
      <polygon points="0,72 40,32 80,72" fill="#1d2b22" />
      <polygon points="20,76 60,26 100,76" fill="#203026" />
      <polygon points="500,76 535,36 570,76" fill="#1d2b22" />
      <polygon points="530,80 565,30 600,80" fill="#203026" />
      <rect y={82} width={600} height={28} fill="#2a3324" />
    </svg>
  )
}
