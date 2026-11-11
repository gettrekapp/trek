// Add a server (6a): scan the desktop's QR (or type its address and code), and the phone redeems
// the one-time code for its own token. Or type an address and an existing named token. A
// trek://pair link only fills this form: nothing is sent until Pair is tapped.
import { useState } from 'react'
import { ScrollView, Text, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Device from 'expo-device'
import { globalSocketFactory, parsePairingLink, redeemPairingCode, PairingError } from '../src/shared.ts'
import { checkServerUrl } from '../src/logic/serverUrl.ts'
import { useServers } from '../src/state/ServersProvider.tsx'
import { Button } from '../src/ui/Button.tsx'
import { ui } from '../src/ui/theme.ts'

const randomId = (): string => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

export default function AddServer(): React.JSX.Element {
  const params = useLocalSearchParams<{ url?: string; code?: string }>()
  const { add } = useServers()
  const [mode, setMode] = useState<'code' | 'token'>('code')
  const [url, setUrl] = useState(params.url ?? '')
  const [code, setCode] = useState(params.code ?? '')
  const [token, setToken] = useState('')
  const [deviceName, setDeviceName] = useState(Device.deviceName ?? 'phone')
  const [scanning, setScanning] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const checked = url.trim() ? checkServerUrl(url) : null

  const scan = async (): Promise<void> => {
    setError(null)
    const granted = permission?.granted || (await requestPermission()).granted
    if (!granted) {
      setError('Trek needs the camera to scan the code. You can type the address and code instead.')
      return
    }
    setScanning(true)
  }

  const scanned = (data: string): void => {
    const link = parsePairingLink(data)
    if (!link) return
    setScanning(false)
    setMode('code')
    setUrl(link.url)
    setCode(link.code)
  }

  const submit = async (): Promise<void> => {
    if (!checked?.ok) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'code') {
        const paired = await redeemPairingCode({ url: checked.url, code: code.trim(), deviceName: deviceName.trim() || 'phone', createSocket: globalSocketFactory, client: 'trek-mobile', clientVersion: '0.1.0' })
        await add({ id: paired.serverId || randomId(), name: paired.serverName || new URL(checked.url).hostname, url: checked.url }, paired.token)
      } else {
        await add({ id: randomId(), name: new URL(checked.url).hostname, url: checked.url }, token.trim())
      }
      router.replace('/servers')
    } catch (err) {
      setError(err instanceof PairingError ? err.message : `Could not add the server: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (scanning) {
    return (
      <View style={ui.screen}>
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => scanned(data)} />
        <View style={ui.pad}>
          <Text style={ui.muted}>Point the camera at the QR in the desktop app's Pair a phone…</Text>
          <Button ghost label="Cancel" onPress={() => setScanning(false)} />
        </View>
      </View>
    )
  }

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled">
      <Button label="Scan the pairing code" onPress={() => void scan()} />
      <Text style={ui.heading}>Or type it</Text>
      <Text style={ui.muted}>Server address</Text>
      <TextInput style={ui.input} value={url} onChangeText={setUrl} placeholder="wss://dev.example.com" placeholderTextColor="#6c7086" autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="Server address" />
      {checked && !checked.ok ? <Text style={ui.error}>{checked.message}</Text> : null}
      {checked?.ok && checked.warning ? <Text style={ui.warn}>{checked.warning}</Text> : null}
      <View style={ui.row}>
        <Button ghost label={mode === 'code' ? '• Pairing code' : 'Pairing code'} onPress={() => setMode('code')} />
        <Button ghost label={mode === 'token' ? '• Access token' : 'Access token'} onPress={() => setMode('token')} />
      </View>
      {mode === 'code' ? (
        <>
          <Text style={ui.muted}>Code (works once, for 5 minutes)</Text>
          <TextInput style={ui.input} value={code} onChangeText={setCode} placeholder="ABCDE-FGHIJ-…" placeholderTextColor="#6c7086" autoCapitalize="characters" autoCorrect={false} accessibilityLabel="Pairing code" />
          <Text style={ui.muted}>This phone's name (the token is named after it)</Text>
          <TextInput style={ui.input} value={deviceName} onChangeText={setDeviceName} autoCorrect={false} accessibilityLabel="Phone name" />
        </>
      ) : (
        <>
          <Text style={ui.muted}>A named token from trek-server token add</Text>
          <TextInput style={ui.input} value={token} onChangeText={setToken} secureTextEntry autoCapitalize="none" autoCorrect={false} accessibilityLabel="Access token" />
        </>
      )}
      <Button label={busy ? 'Pairing…' : mode === 'code' ? 'Pair' : 'Add'} disabled={busy || !checked?.ok || (mode === 'code' ? !code.trim() : !token.trim())} onPress={() => void submit()} />
      {error ? <Text style={ui.error}>{error}</Text> : null}
    </ScrollView>
  )
}
