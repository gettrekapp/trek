// Add a worktree to a repository: on a new or an existing branch, or from a pull request through
// the PR providers on for the project (the desktop's Add Worktree dialog). A pull request's branch
// is its own when the server can name it (pr.resolve), else pr/<n>. The new worktree's screen
// replaces this one; no session is started.
import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native'
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { branchSuggestions, prBranch } from '../../../../../src/logic/worktrees.ts'
import { activePrProviders } from '../../../../../src/logic/pullRequests.ts'
import { CAPABILITY, parsePrWith } from '../../../../../src/shared.ts'
import { repoFolder, worktreeOnBranch } from '../../../../../src/logic/worktreeList.ts'
import { worktreeRoute } from '../../../../../src/logic/routes.ts'
import { errorMessage, useConnectionNotice, useServer, useTopic } from '../../../../../src/state/hooks.ts'
import { noticeAlert } from '../../../../../src/ui/alerts.ts'
import { Button } from '../../../../../src/ui/Button.tsx'
import { colors, ui } from '../../../../../src/ui/theme.ts'
import { useGlobalTray } from '../../../../../src/ui/globalTrayContext.tsx'

export default function AddWorktreeScreen(): React.JSX.Element {
  const { serverId, projectId, repoId } = useLocalSearchParams<{ serverId: string; projectId: string; repoId: string }>()
  const server = useServer(serverId)
  const topic = useTopic(serverId, `project:${projectId}`)
  const notice = useConnectionNotice(serverId)
  const headerHeight = useHeaderHeight()
  // An open Global tray has the keyboard: this screen, under it, keeps its size.
  const tray = useGlobalTray()
  const project = topic.state === 'ready' ? topic.snapshot : null
  const repo = project?.repositories.find((r) => r.id === repoId)

  const [branches, setBranches] = useState<string[]>([])
  const [branchesError, setBranchesError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [existing, setExisting] = useState(false)
  const [prUrl, setPrUrl] = useState('')
  const [busy, setBusy] = useState<'create' | 'pr' | null>(null)
  // The last request's error, shown under the button that made it.
  const [error, setError] = useState<{ kind: 'create' | 'pr'; text: string } | null>(null)
  // One request at a time, also for two taps before the buttons are drawn disabled.
  const running = useRef(false)
  // Whether this screen is the one shown: a request that ends after it went (Back), or under
  // another screen (a notification's), neither navigates nor touches its state.
  const shown = useRef(false)
  useFocusEffect(
    useCallback(() => {
      shown.current = true
      return () => {
        shown.current = false
      }
    }, [])
  )
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // The repository's branches, for the suggestions; without them the form still works.
  useEffect(() => {
    if (!server) return
    let cancelled = false
    setBranchesError(null)
    server.connection
      .request('repo.listBranches', { projectId, repoId })
      .then((list) => {
        if (!cancelled) setBranches(list)
      })
      .catch((err) => {
        if (!cancelled) setBranchesError(`Could not load the branches: ${errorMessage(err)}`)
      })
    return () => {
      cancelled = true
    }
  }, [server, projectId, repoId])

  const branch = name.trim()
  const welcome = server?.connection.welcome
  const providers = project ? activePrProviders(welcome, project.settings) : []
  const pr = parsePrWith(providers, prUrl)
  // Whether the server names a pull request's head branch (pr.resolve) and takes worktree.create's prUrl.
  const canResolve = welcome?.capabilities.includes(CAPABILITY.prResolve) === true
  const suggestions = branchSuggestions(branches, name)

  /** One request at a time; its error shows on the screen and the form keeps what was typed. */
  const run = async (kind: 'create' | 'pr', fn: () => Promise<void>): Promise<void> => {
    if (running.current) return
    running.current = true
    setBusy(kind)
    setError(null)
    try {
      await fn()
    } catch (err) {
      if (mounted.current) setError({ kind, text: errorMessage(err) })
    } finally {
      running.current = false
      if (mounted.current) setBusy(null)
    }
  }

  /** The answer's link warnings, to read before going on. */
  const warn = async (linkWarnings: string[] | undefined): Promise<void> => {
    if (linkWarnings?.length && mounted.current) await noticeAlert('The worktree was created', `Some linked folders could not be linked:\n${linkWarnings.join('\n')}`)
  }
  /** The worktree's screen instead of this one, after any link warnings are read. */
  const open = async (worktreeId: string, linkWarnings?: string[]): Promise<void> => {
    await warn(linkWarnings)
    if (shown.current) router.replace(worktreeRoute(serverId, projectId, worktreeId))
  }

  const create = (): void => {
    if (!server || !branch) return
    const conn = server.connection
    void run('create', async () => {
      const created = await conn.request('worktree.create', { projectId, repoId, branch, createBranch: !existing })
      await open(created.worktreeId, created.linkWarnings)
    })
  }

  const addPr = (): void => {
    if (!server || !repo || !pr) return
    const conn = server.connection
    void run('pr', async () => {
      // The server's providers name the PR's head branch; null (or an older server) → pr/<n>. Its
      // refusal (BAD_REQUEST: no provider there takes the link) shows under the button.
      const resolved = canResolve ? await conn.request('pr.resolve', { projectId, repoId, input: pr.url }) : null
      const prBranchName = resolved?.headBranch ?? prBranch(pr.number)
      const link = (): Promise<null> => conn.request('branch.setPr', { projectId, repoId, branch: prBranchName, pr: pr.url })
      // The PR's branch may already be checked out: the PR is linked to that worktree.
      const has = worktreeOnBranch(repo, prBranchName)
      if (has) {
        await link()
        await open(has.id)
        return
      }
      const created = await conn.request('worktree.create', {
        projectId,
        repoId,
        branch: prBranchName,
        createBranch: false,
        fromPr: pr.number,
        ...(canResolve ? { prUrl: pr.url } : {})
      })
      try {
        await link()
      } catch (err) {
        // The worktree is there now: Add PR again finds it and only links.
        await warn(created.linkWarnings)
        throw new Error(`The worktree ${prBranchName} was created, but the pull request could not be linked to it: ${errorMessage(err)}. Add PR again links it.`)
      }
      await open(created.worktreeId, created.linkWarnings)
    })
  }

  const blocked = busy !== null || !server || !repo

  return (
    <KeyboardAvoidingView style={ui.screen} behavior="padding" keyboardVerticalOffset={headerHeight} enabled={tray === null || tray.height === 'collapsed'}>
      <Stack.Screen options={{ title: 'Add worktree' }} />
      <ScrollView style={ui.screen} contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled">
        {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
        {topic.state === 'loading' ? <Text style={ui.muted}>Loading…</Text> : null}
        {project && !repo ? <Text style={ui.muted}>This repository is gone.</Text> : null}
        {repo ? <Text style={ui.title}>{repo.name}</Text> : null}

        <Text style={ui.heading}>Create new worktree</Text>
        <TextInput
          style={ui.input}
          value={name}
          onChangeText={setName}
          placeholder="branch name"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          accessibilityLabel="Branch name"
        />
        {branchesError ? <Text style={ui.error}>{branchesError}</Text> : null}
        {suggestions.length ? (
          <View style={ui.card}>
            {suggestions.map((b) => (
              <Pressable
                key={b}
                accessibilityRole="button"
                accessibilityLabel={`Use the branch ${b}`}
                disabled={busy !== null}
                onPress={() => {
                  setName(b)
                  setExisting(true)
                }}
                style={{ paddingVertical: 6 }}
              >
                <Text style={ui.text}>{b}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={[ui.row, { justifyContent: 'space-between' }]}>
          <Text style={ui.text}>Use existing branch</Text>
          <Switch
            value={existing}
            onValueChange={setExisting}
            disabled={busy !== null}
            trackColor={{ false: colors.border, true: colors.accent }}
            accessibilityLabel="Use existing branch"
          />
        </View>
        <Button label={busy === 'create' ? 'Creating…' : 'Create'} disabled={blocked || !branch} onPress={create} />
        {error?.kind === 'create' ? <Text style={ui.error}>{error.text}</Text> : null}
        <Text style={ui.muted}>
          New worktrees are created next to the repository as {repo ? repoFolder(repo.path) : '<repository>'}-&lt;branch&gt;. New branches are cut from the latest master/main (fetched from origin first).
        </Text>

        <Text style={ui.heading}>From a pull request</Text>
        {project && welcome && providers.length === 0 ? (
          <Text style={ui.muted}>No pull request provider is on in this project. Turn one on in the desktop app's Settings → Plugins.</Text>
        ) : (
          <>
            <TextInput
              style={ui.input}
              value={prUrl}
              onChangeText={setPrUrl}
              placeholder={providers[0]?.hint ?? 'a pull request link'}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              keyboardType="url"
              accessibilityLabel="Pull request link"
            />
            {prUrl.trim() && !pr && providers.length > 0 ? <Text style={ui.muted}>Not {providers.map((p) => p.hint).join(', or ')}</Text> : null}
            <Button label={busy === 'pr' ? 'Adding…' : 'Add PR'} disabled={blocked || !pr} onPress={addPr} />
            {error?.kind === 'pr' ? <Text style={ui.error}>{error.text}</Text> : null}
          </>
        )}
        <Text style={ui.muted}>
          Checks out the pull request's branch into a new worktree and links the PR to it. The branch is the pull request's own when the server can tell, else pr/&lt;number&gt;.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
