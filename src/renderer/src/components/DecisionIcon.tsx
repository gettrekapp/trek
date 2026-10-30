import { useAppStore } from '../store'

interface Props {
  terminalId: string
}

/** Flag on a session that asked for a decision; clicking it dismisses the request. */
export function DecisionIcon({ terminalId }: Props): React.JSX.Element | null {
  const decision = useAppStore((s) => s.decisions[terminalId])
  if (!decision) return null
  return (
    <span
      className="decision-icon clickable"
      title={`Needs a decision: ${decision.question}\nClick to dismiss`}
      onClick={(e) => {
        e.stopPropagation()
        useAppStore.getState().clearDecision(terminalId)
      }}
    >
      ⚑
    </span>
  )
}
