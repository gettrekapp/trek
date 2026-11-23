// "While you were away" (campsite part 3a): what the camp earned while nobody looked, by source,
// with markers and level-ups. Shown in every window while the snapshot carries `away`; its dismiss
// (awaySeen) clears it everywhere with the next push.
import { awayText, type AwaySnapshot } from '../shared/away.ts'

export function AwayCard({ away, onDismiss }: { away: AwaySnapshot; onDismiss: () => void }): React.JSX.Element {
  return (
    <div className="cs-away" role="status">
      <span className="cs-away-text">{awayText(away)}</span>
      <button className="cs-away-dismiss" onClick={onDismiss}>
        Got it
      </button>
    </div>
  )
}
