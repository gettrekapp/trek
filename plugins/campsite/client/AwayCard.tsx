// "While you were away" (campsite part 3a): what the camp earned while nobody looked, by source,
// with markers and level-ups. Shown in every window while the snapshot carries `away`; its dismiss
// (awaySeen) clears it everywhere with the next push. One line in the strip's header (cut short
// with an ellipsis, the whole line in its tooltip); above the bar when collapsed.
import { awayText, type AwaySnapshot } from '../shared/away.ts'

export function AwayCard({ away, onDismiss }: { away: AwaySnapshot; onDismiss: () => void }): React.JSX.Element {
  const text = awayText(away)
  return (
    <div className="cs-away" role="status" title={text}>
      <span className="cs-away-text">{text}</span>
      <button className="cs-away-dismiss" onClick={onDismiss}>
        Got it
      </button>
    </div>
  )
}
