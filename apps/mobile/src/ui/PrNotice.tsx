// A worktree's pull request notice (what the server's watch last reported: PROTOCOL.md, "Pull
// request watch"): its title, text and age, Open (the pull request, in the browser) and Dismiss
// (prWatch.dismiss). The notice is the snapshot's: it goes when the server says so, not at the tap.
// DismissNotice is the button alone, for the Attention list's pull request items.
import { useEffect, useRef, useState } from 'react'
import { Linking, Text, View } from 'react-native'
import type { PrNotice as Notice } from '../shared.ts'
import { webLink } from '../logic/branchDetails.ts'
import { noticeAge } from '../logic/prWatch.ts'
import { errorMessage, useServer } from '../state/hooks.ts'
import { Button } from './Button.tsx'
import { explainDemoPullRequest } from './demoLink.ts'
import { colors, ui } from './theme.ts'

/** Dismissing a worktree's notice: one request at a time; its failure is `error`. Nothing is set once the component is gone. */
function useDismiss(serverId: string, projectId: string, worktreeId: string): { off: boolean; busy: boolean; error: string | null; setError: (error: string | null) => void; dismiss: () => void } {
  const server = useServer(serverId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Also for two taps before the button is drawn disabled.
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const dismiss = (): void => {
    if (!server || running.current) return
    running.current = true
    setBusy(true)
    setError(null)
    server.connection
      .request('prWatch.dismiss', { projectId, worktreeId })
      .catch((err: unknown) => {
        if (mounted.current) setError(errorMessage(err))
      })
      .finally(() => {
        running.current = false
        if (mounted.current) setBusy(false)
      })
  }
  return { off: busy || !server, busy, error, setError, dismiss }
}

/** Dismiss for a pull request item in the Attention list, with its failure under it. */
export function DismissNotice({ serverId, projectId, worktreeId }: { serverId: string; projectId: string; worktreeId: string }): React.JSX.Element {
  const { off, busy, error, dismiss } = useDismiss(serverId, projectId, worktreeId)
  return (
    <View style={{ marginTop: 6, gap: 4 }}>
      <View style={ui.row}>
        <Button ghost label={busy ? 'Dismissing…' : 'Dismiss'} disabled={off} onPress={dismiss} />
      </View>
      {error ? <Text style={ui.error}>{error}</Text> : null}
    </View>
  )
}

export function PrNotice({ serverId, projectId, worktreeId, notice }: { serverId: string; projectId: string; worktreeId: string; notice: Notice }): React.JSX.Element {
  const { off, busy, error, setError, dismiss } = useDismiss(serverId, projectId, worktreeId)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // Only http(s) is opened: the link is whatever was stored for the branch.
  const link = webLink(notice.url)
  const open = async (url: string): Promise<void> => {
    setError(null)
    if (explainDemoPullRequest(serverId)) return
    try {
      await Linking.openURL(url)
    } catch (err) {
      if (mounted.current) setError(`Could not open ${url}: ${errorMessage(err)}`)
    }
  }
  return (
    <View style={[ui.card, { borderColor: colors.attention }]}>
      <View style={[ui.row, { justifyContent: 'space-between' }]}>
        <Text style={[ui.title, { flexShrink: 1 }]}>{notice.title}</Text>
        <Text style={ui.muted}>{noticeAge(notice, now)}</Text>
      </View>
      <Text style={ui.warn}>{notice.text}</Text>
      <View style={[ui.row, { flexWrap: 'wrap', marginTop: 6 }]}>
        {link ? <Button ghost label="Open" onPress={() => void open(link)} /> : null}
        <Button ghost label={busy ? 'Dismissing…' : 'Dismiss'} disabled={off} onPress={dismiss} />
      </View>
      {error ? <Text style={ui.error}>{error}</Text> : null}
    </View>
  )
}
