import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { loadVoiceSettings, speakSummary, updateVoiceConfig } from '../voice'
import type { VoiceInfo } from '../../../shared/types'

const MODELS = [
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 — fastest, cheapest' },
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5 — fast, higher quality' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 — most natural' }
]

/** ElevenLabs key and voice — stored on this machine, shared by every project. */
export function VoiceSettings(): React.JSX.Element {
  const voice = useAppStore((s) => s.voice)
  const [apiKey, setApiKey] = useState('')
  const [voices, setVoices] = useState<VoiceInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const connected = !!voice?.hasApiKey

  useEffect(() => {
    if (!connected) return
    window.api
      .voiceListVoices()
      .then(setVoices)
      .catch((err: Error) => setError(err.message))
  }, [connected])

  const connect = async (): Promise<void> => {
    if (!apiKey.trim()) return
    setBusy(true)
    setError(null)
    const result = await window.api.voiceSetApiKey(apiKey)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setApiKey('')
    setVoices(result.voices)
    await loadVoiceSettings()
  }

  const disconnect = async (): Promise<void> => {
    await window.api.voiceClearApiKey()
    setVoices([])
    await loadVoiceSettings()
  }

  const test = async (): Promise<void> => {
    setError(null)
    try {
      const result = await speakSummary('', 'This is how spoken summaries from your Claude sessions will sound.')
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
            Lets Claude sessions read a short summary aloud (the speak_summary tool), while the
            sidebar toggle is set to Active. Stored encrypted on this machine, not in the project
            file.
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
                onChange={(e) => void updateVoiceConfig({ voiceId: e.target.value })}
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
              onChange={(e) => void updateVoiceConfig({ promptSessions: e.target.checked })}
            />
            <span className="settings-label">
              <span className="settings-name">Summarize automatically</span>
              <span className="settings-desc">
                Tell every Claude session to speak a summary when it finishes a task or stops to
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
              onChange={(e) => void updateVoiceConfig({ modelId: e.target.value })}
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
