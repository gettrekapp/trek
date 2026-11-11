// An agent's promote_to_primary, confirmed from the phone (6a) while the project is open, through
// 5e's steps: promote.listen; on a request, a dry run; then the user confirms, the phone claims it
// (promote.claim) and runs worktree.promote {requestId}, and the server settles it with its own
// result. The phone can't tear down a dev stack or VM: with either running it says to confirm on
// the desktop and neither claims nor answers. A request another window claims or ends closes here.
import { useEffect, useRef, useState } from 'react'
import { Modal, Text, View } from 'react-native'
import { CAPABILITY, type Project, type PromoteRequestEvent, type PromoteSettledEvent } from '../shared.ts'
import { useServer, errorMessage } from '../state/hooks.ts'
import { Button } from './Button.tsx'
import { colors, ui } from './theme.ts'

type Prompt =
  | { kind: 'confirm'; request: PromoteRequestEvent; summary: string }
  | { kind: 'desktop'; request: PromoteRequestEvent; why: string }
  | { kind: 'running'; request: PromoteRequestEvent }
  | { kind: 'result'; request: PromoteRequestEvent; text: string; failed: boolean }

export function PromotePrompt({ serverId, projectId, project }: { serverId: string; projectId: string; project: Project | null }): React.JSX.Element | null {
  const server = useServer(serverId)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const projectRef = useRef(project)
  projectRef.current = project
  const promptRef = useRef(prompt)
  promptRef.current = prompt

  useEffect(() => {
    if (!server) return
    const conn = server.connection
    const can = (): boolean => conn.welcome?.capabilities.includes(CAPABILITY.promote) === true
    const listen = (on: boolean): void => {
      if (can()) void conn.request('promote.listen', { projectId, listen: on }).catch(() => {})
    }
    listen(true)
    // Listening is per connection: again after a reconnect.
    const offWelcome = conn.on('welcome', () => listen(true))
    const offEvent = conn.on('event', ({ event, payload }) => {
      if (event === 'promote.settled') {
        const settled = payload as PromoteSettledEvent
        const open = promptRef.current
        // Another window claimed or the request ended: close it, unless this phone is running it.
        if (open && open.request.requestId === settled.requestId && open.kind !== 'running' && open.kind !== 'result') setPrompt(null)
        return
      }
      if (event !== 'promote.request') return
      const request = payload as PromoteRequestEvent
      if (request.projectId !== projectId || promptRef.current) return
      void ask(request)
    })
    const ask = async (request: PromoteRequestEvent): Promise<void> => {
      const repo = projectRef.current?.repositories.find((r) => r.worktrees.some((w) => w.id === request.worktreeId))
      const worktree = repo?.worktrees.find((w) => w.id === request.worktreeId)
      if (!repo || !worktree) {
        await conn.request('promote.answer', { projectId, requestId: request.requestId, outcome: 'unknown-worktree' }).catch(() => {})
        return
      }
      let summary: string
      try {
        const plan = await conn.request('worktree.promote', { projectId, worktreeId: request.worktreeId, dryRun: true })
        if (!('mainPath' in plan)) return
        summary =
          `${plan.branch} is checked out in the main checkout (${plan.mainPath}) and this worktree is removed.` +
          (plan.dirty ? ' Its uncommitted work comes along, unstaged.' : '') +
          (plan.sessions.length ? ` ${plan.sessions.length} session(s) move and resume.` : '') +
          (plan.otherLoaded ? " The main checkout's running sessions keep running on the new branch." : '') +
          (plan.ignoredCount ? ` ${plan.ignoredCount} ignored file(s) in the worktree are deleted with it.` : '') +
          (plan.overwrittenIgnoredCount ? ` ${plan.overwrittenIgnoredCount} ignored file(s) in the main checkout are overwritten.` : '')
      } catch (err) {
        // Refused (dirty main checkout, a lock…): one window answers it, without a dialog.
        const claim = await conn.request('promote.claim', { projectId, requestId: request.requestId }).catch(() => null)
        if (claim?.accepted) await conn.request('promote.answer', { projectId, requestId: request.requestId, outcome: 'failed', error: errorMessage(err).slice(0, 500) }).catch(() => {})
        return
      }
      const caps = conn.welcome?.capabilities ?? []
      const stack = caps.includes(CAPABILITY.stacks) ? await conn.request('stack.status', { projectId, worktreeId: worktree.id }).catch(() => null) : null
      const envs = caps.includes(CAPABILITY.env) ? await conn.request('env.list', { projectId, repoId: repo.id }).catch(() => []) : []
      const vm = envs.find((e) => e.worktreePath === worktree.path && e.vmState === 'running')
      if (stack && (stack.containers > 0 || stack.upRunning)) setPrompt({ kind: 'desktop', request, why: 'its dev stack is running' })
      else if (vm) setPrompt({ kind: 'desktop', request, why: `its Docker VM (${vm.profile}) is running` })
      else setPrompt({ kind: 'confirm', request, summary })
    }
    return () => {
      offWelcome()
      offEvent()
      listen(false)
    }
  }, [server, projectId])

  if (!prompt || !server) return null
  const conn = server.connection
  const { request } = prompt
  const close = (): void => setPrompt(null)
  const decline = (): void => {
    void conn.request('promote.answer', { projectId, requestId: request.requestId, outcome: 'declined' }).catch(() => {})
    close()
  }
  const confirm = async (): Promise<void> => {
    setPrompt({ kind: 'running', request })
    try {
      const claim = await conn.request('promote.claim', { projectId, requestId: request.requestId })
      if (!claim.accepted) {
        setPrompt({ kind: 'result', request, failed: true, text: 'This request has already ended (answered elsewhere, or the agent stopped waiting); nothing was done.' })
        return
      }
      const result = await conn.request('worktree.promote', { projectId, worktreeId: request.worktreeId, requestId: request.requestId, claimToken: claim.claimToken })
      const notes = 'notes' in result && result.notes.length ? ` ${result.notes.join(' ')}` : ''
      setPrompt({ kind: 'result', request, failed: false, text: `${request.branch} is in the main checkout now.${notes}` })
    } catch (err) {
      setPrompt({ kind: 'result', request, failed: true, text: `Could not promote: ${errorMessage(err)}` })
    }
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={prompt.kind === 'confirm' ? decline : prompt.kind === 'running' ? undefined : close}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}>
        <View style={[ui.card, { gap: 10 }]} accessibilityViewIsModal>
          <Text style={ui.title}>Promote {request.branch} to the main checkout?</Text>
          {request.from ? <Text style={ui.muted}>Asked by the session “{request.from}”.</Text> : null}
          {prompt.kind === 'confirm' ? (
            <>
              <Text style={ui.text}>{prompt.summary}</Text>
              <View style={ui.row}>
                <Button label="Promote" onPress={() => void confirm()} />
                <Button ghost label="Decline" onPress={decline} />
              </View>
            </>
          ) : null}
          {prompt.kind === 'desktop' ? (
            <>
              <Text style={ui.warn}>Confirm this on the desktop: {prompt.why}, and only the desktop can tear it down first.</Text>
              <Button ghost label="OK" onPress={close} />
            </>
          ) : null}
          {prompt.kind === 'running' ? <Text style={ui.muted}>Promoting…</Text> : null}
          {prompt.kind === 'result' ? (
            <>
              <Text style={{ color: prompt.failed ? colors.danger : colors.ok }}>{prompt.text}</Text>
              <Button ghost label="OK" onPress={close} />
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  )
}
