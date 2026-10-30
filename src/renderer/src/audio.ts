import { useAppStore } from './store'

/**
 * Alert sound for "Claude is ready for input" transitions. The mp3 ships in
 * resources/ and is fetched once through the main process (the renderer has
 * no filesystem access), then cached as a blob-backed Audio element.
 */

let audio: HTMLAudioElement | null = null
let loading: Promise<void> | null = null

async function ensureLoaded(): Promise<void> {
  if (audio || loading) return loading ?? undefined
  loading = (async () => {
    const data = await window.api.getAlertSound()
    if (data) {
      const blob = new Blob([data as BlobPart], { type: 'audio/mpeg' })
      audio = new Audio(URL.createObjectURL(blob))
      audio.volume = 0.6
    }
  })()
  return loading
}

/** Plays the alert if audio alerts are enabled in the project settings. */
export function playReadyAlert(): void {
  if (!useAppStore.getState().project?.audioAlerts) return
  void ensureLoaded().then(() => {
    if (!audio) return
    audio.currentTime = 0
    audio.play().catch(() => {
      // autoplay restrictions or device issues — never break the app over a sound
    })
  })
}
