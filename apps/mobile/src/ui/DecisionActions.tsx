// A request_decision answered from the phone (6a): an answer typed to the session (which clears
// the decision, as any input to the session does) or Dismiss (session.dismissDecision).
import { useState } from 'react'
import { Text, TextInput, View } from 'react-native'
import { useServer, errorMessage } from '../state/hooks.ts'
import { Button } from './Button.tsx'
import { ui } from './theme.ts'

export function DecisionActions({ serverId, projectId, sessionId }: { serverId: string; projectId: string; sessionId: string }): React.JSX.Element {
  const server = useServer(serverId)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setAnswer('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={{ gap: 8, marginTop: 8 }}>
      <TextInput style={ui.input} placeholder="Your answer" placeholderTextColor="#6c7086" value={answer} onChangeText={setAnswer} accessibilityLabel="Your answer" />
      <View style={ui.row}>
        <Button label="Send answer" disabled={!server || busy || !answer.trim()} onPress={() => void run(() => server!.connection.request('session.sendPrompt', { projectId, sessionId, text: answer.trim() }))} />
        <Button ghost label="Dismiss" disabled={!server || busy} onPress={() => void run(() => server!.connection.request('session.dismissDecision', { projectId, sessionId }))} />
      </View>
      {error ? <Text style={ui.error}>{error}</Text> : null}
    </View>
  )
}
