// The demo's sample pull request is not a real one: opening it would land on a GitHub 404.
import { Alert } from 'react-native'
import { DEMO_SERVER_ID } from '../demo/index.ts'

/** True when the link is the demo's pull request, which was only explained, not opened */
export function explainDemoPullRequest(serverId: string): boolean {
  if (serverId !== DEMO_SERVER_ID) return false
  Alert.alert('Demo pull request', 'In the demo, this would open the pull request on GitHub.')
  return true
}
