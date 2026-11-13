import { useEffect, useState } from 'react'
import { usePluginHost } from '../../../src/shared/plugins/client.ts'
import type { VoiceInfo } from '../shared/types.ts'
import { loadVoiceSettings, setVoiceKey, testVoice, updateVoiceConfig } from './playback.ts'
import { useVoiceStore } from './store.ts'

const MODELS = [
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 — fastest, cheapest' },
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5 — fast, higher quality' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 — most natural' }
]

/** ElevenLabs key and voice — the window's server's, shared by every project on it. */
export function VoiceSettings(): React.JSX.Element {
  const host = usePluginHost()
  const voice = useVoiceStore((s) => s.settings)
  const [apiKey, setApiKey] = useState('')
  const [voices, setVoices] = useState<VoiceInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const connected = !!voice?.hasApiKey

  useEffect(() => {
    if (!connected) return
    host
      .request<VoiceInfo[]>('voices')
      .then(setVoices)
      .catch((err: Error) => setError(err.message))
  }, [connected, host])

  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))

  const connect = async (): Promise<void> => {
    if (!apiKey.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await setVoiceKey(host, apiKey)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setApiKey('')
      setVoices(result.voices)
      await loadVoiceSettings(host)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    try {
      await host.request('clearKey')
      setVoices([])
      await loadVoiceSettings(host)
    } catch (err) {
      fail(err)
    }
  }

  const update = (patch: Parameters<typeof updateVoiceConfig>[1]): void => {
    setError(null)
    updateVoiceConfig(host, patch).catch(fail)
  }

  const test = async (): Promise<void> => {
    setError(null)
    try {
      const result = await testVoice(host, 'This is how spoken summaries from your agent sessions will sound.')
      if (!result.played) setError(result.reason)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <h3>Voice summaries</h3>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">ElevenLabs API key</span>
          <span className="settings-desc">
            Lets agent sessions read a short summary aloud (the speak_summary tool) in every window
            that has their project open, while that app&apos;s sidebar toggle is set to Active. Stored
            on this project&apos;s server (owner-only, never sent back), with its voice and model,
            for every project on it.
          </span>
          {error && <span className="settings-desc settings-warn">{error}</span>}
        </span>
        {connected ? (
          <button className="btn btn-ghost" onClick={() => void disconnect()}>
            Disconnect
          </button>
        ) : (
          <span className="linear-key-input">
            <input
              className="settings-select"
              type="password"
              placeholder="sk_…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void connect()
              }}
            />
            <button className="btn btn-ghost" disabled={busy} onClick={() => void connect()}>
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </span>
        )}
      </div>
      {connected && voice && (
        <>
          <div className="settings-row">
            <span className="settings-label">
              <span className="settings-name">Voice</span>
            </span>
            <span className="linear-key-input">
              <select
                className="settings-select"
                value={voice.voiceId}
                onChange={(e) => update({ voiceId: e.target.value })}
              >
                {!voices.some((v) => v.id === voice.voiceId) && (
                  <option value={voice.voiceId}>{voice.voiceId || 'Choose a voice'}</option>
                )}
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
              <button className="btn btn-ghost" onClick={() => void test()}>
                Test
              </button>
            </span>
          </div>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={voice.promptSessions}
              onChange={(e) => update({ promptSessions: e.target.checked })}
            />
            <span className="settings-label">
              <span className="settings-name">Summarize automatically</span>
              <span className="settings-desc">
                Tell every agent session to speak a summary when it finishes a task or stops to
                wait on you. Off, sessions use the tool only when a prompt asks them to. Takes
                effect the next time each session starts or resumes.
              </span>
            </span>
          </label>
          <div className="settings-row">
            <span className="settings-label">
              <span className="settings-name">Model</span>
            </span>
            <select
              className="settings-select"
              value={voice.modelId}
              onChange={(e) => update({ modelId: e.target.value })}
            >
              {!MODELS.some((m) => m.id === voice.modelId) && (
                <option value={voice.modelId}>{voice.modelId}</option>
              )}
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </>
  )
}
