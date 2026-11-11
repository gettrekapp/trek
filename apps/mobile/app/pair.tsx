// A trek://pair?url=…&code=… link (the desktop's QR, opened by the camera app): only fills the
// Add server form; nothing is redeemed without a tap there.
import { Redirect, useLocalSearchParams } from 'expo-router'

export default function PairLink(): React.JSX.Element {
  const { url, code } = useLocalSearchParams<{ url?: string; code?: string }>()
  return <Redirect href={{ pathname: '/add-server', params: { url: url ?? '', code: code ?? '' } }} />
}
