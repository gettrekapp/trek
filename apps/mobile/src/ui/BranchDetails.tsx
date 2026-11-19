// The worktree screen's Branch section: the branch's workflow tag, custom tags, note, ticket and
// pull request (with its watch: logic/prWatch.ts), read from the project's snapshot and saved at
// once with the matching branch.set* request. A failure shows in the section's error line; the snapshot remains the truth. The
// project's tag lists are not edited here, and a ticket's title and status are not looked up.
// History opens the branch's change log (app/project/[serverId]/[projectId]/history), on a server that keeps one.
import { useEffect, useRef, useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { CAPABILITY, DEFAULT_WORKTREE_TAGS, type Project, type Repository, type ServerConnection } from '../shared.ts'
import { beginNoteEdit, chipColors, isNoteConflict, noteConflicted, noteSave, pullRequestInput, pullRequestText, toggledCustomTags, webLink, type NoteEdit } from '../logic/branchDetails.ts'
import { watchAction, watchOffered, watchSuffix } from '../logic/prWatch.ts'
import { activeTicketProviders, parseTicketInput, ticketView } from '../logic/tickets.ts'
import { activePrProviders } from '../logic/pullRequests.ts'
import { historyRoute } from '../logic/routes.ts'
import { errorMessage, useServer } from '../state/hooks.ts'
import { Button } from './Button.tsx'
import { explainDemoPullRequest } from './demoLink.ts'
import { colors, ui } from './theme.ts'

interface Tag {
  id: string
  name: string
  color: string
}

/** A tag as a choice: filled with its colour when selected, outlined in it otherwise. */
function TagChip({ tag, selected, disabled, onPress }: { tag: Tag; selected: boolean; disabled: boolean; onPress: () => void }): React.JSX.Element {
  const { fill, text } = chipColors(tag.color)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, { borderColor: fill, backgroundColor: selected ? fill : 'transparent', opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
    >
      <Text style={[styles.chipText, { color: selected ? text : colors.text }]}>{tag.name}</Text>
    </Pressable>
  )
}

export function BranchDetails({ serverId, projectId, project, repo, branch, heading = true }: { serverId: string; projectId: string; project: Project; repo: Repository; branch: string; /** false under a row that already names the section */ heading?: boolean }): React.JSX.Element {
  const server = useServer(serverId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The editor that is open (one at a time), the note's edit, and the ticket or pull request box's text.
  const [editing, setEditing] = useState<'note' | 'ticket' | 'pr' | null>(null)
  const [note, setNote] = useState<NoteEdit>(() => beginNoteEdit(undefined))
  const [text, setText] = useState('')
  /** Typing in the ticket or pull request box takes away what was said about the text before. */
  const type = (value: string): void => {
    setText(value)
    setError(null)
  }
  // One request at a time, also for two taps before the buttons are drawn disabled.
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const settings = project.settings
  const data = Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : undefined
  const tags: readonly Tag[] = settings.worktreeTags ?? DEFAULT_WORKTREE_TAGS
  const customTags: readonly Tag[] = settings.customTags ?? []
  const trackers = activeTicketProviders(server?.connection.welcome, settings)
  const prHosts = activePrProviders(server?.connection.welcome, settings)
  const ticket = data?.ticket ? ticketView(trackers, settings, data.ticket) : null
  const ticketLink = webLink(ticket?.url)
  const prLink = webLink(data?.pr)
  // Whether the server can watch a pull request now (its host is signed in there), as its current welcome
  // says; while its connection is being made again the last answer holds, so a watch is not called
  // paused for a reconnect.
  const canWatch = useRef(false)
  const welcome = server?.connection.welcome
  if (welcome) canWatch.current = welcome.capabilities.includes(CAPABILITY.prWatch)
  // Whether the server keeps a history of its branches, held the same way across a reconnect.
  const hasHistory = useRef(false)
  if (welcome) hasHistory.current = welcome.capabilities.includes(CAPABILITY.history)
  const watch = watchAction(data)
  const ref = { projectId, repoId: repo.id, branch }
  const off = busy || !server

  /**
   * One request at a time; true when it was made and the server took it. Its failure shows in the
   * error line, unless `handled` takes it. Nothing is set once the section is gone.
   */
  const send = async (request: (conn: ServerConnection) => Promise<unknown>, handled?: (err: unknown) => boolean): Promise<boolean> => {
    if (!server || running.current) return false
    running.current = true
    setBusy(true)
    setError(null)
    try {
      await request(server.connection)
      return true
    } catch (err) {
      if (mounted.current && !handled?.(err)) setError(errorMessage(err))
      return false
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }

  /** A save or a clear from an editor, which closes when the server took it. */
  const sendAndClose = async (request: (conn: ServerConnection) => Promise<unknown>, handled?: (err: unknown) => boolean): Promise<void> => {
    if ((await send(request, handled)) && mounted.current) setEditing(null)
  }

  const edit = (which: 'note' | 'ticket' | 'pr'): void => {
    setError(null)
    if (which === 'note') setNote(beginNoteEdit(data?.note))
    else setText((which === 'ticket' ? data?.ticket : data?.pr) ?? '')
    setEditing(which)
  }
  const cancel = (): void => {
    setError(null)
    setEditing(null)
  }

  const open = async (url: string, pullRequest = false): Promise<void> => {
    setError(null)
    if (pullRequest && explainDemoPullRequest(serverId)) return
    try {
      await Linking.openURL(url)
    } catch (err) {
      if (mounted.current) setError(`Could not open ${url}: ${errorMessage(err)}`)
    }
  }

  // The snapshot's note as the last render had it: what a refusal, which comes later, is shown with.
  const serverNote = useRef(data?.note)
  serverNote.current = data?.note

  const saveNote = (): void => {
    const saved = noteSave(note)
    void sendAndClose(
      (conn) => conn.request('branch.setNote', { ...ref, ...saved }),
      (err) => {
        if (!isNoteConflict(err)) return false
        // The box stays open with the user's text (as it is now, had it changed while saving); the
        // next Save is guarded by the server's note, shown under it.
        setNote((now) => noteConflicted(now, serverNote.current))
        return true
      }
    )
  }

  const saveTicket = (): void => {
    if (!text.trim() || running.current) return
    const parsed = parseTicketInput(trackers, text)
    if ('error' in parsed) {
      setError(parsed.error)
      return
    }
    void sendAndClose((conn) => conn.request('branch.setTicket', { ...ref, ticket: parsed.ticketId }))
  }

  const savePr = (): void => {
    const parsed = pullRequestInput(prHosts, text, data?.pr)
    if (!parsed || running.current) return
    if ('unchanged' in parsed) {
      cancel()
      return
    }
    if ('error' in parsed) {
      setError(parsed.error)
      return
    }
    void sendAndClose((conn) => conn.request('branch.setPr', { ...ref, pr: parsed.pr }))
  }

  /** The buttons under an editor's box: Save, Cancel, and Clear when there is something to clear. */
  const editorButtons = (save: () => void, canSave: boolean, clear?: () => void): React.JSX.Element => (
    <View style={[ui.row, { flexWrap: 'wrap', marginTop: 6 }]}>
      <Button label={busy ? 'Saving…' : 'Save'} disabled={off || !canSave} onPress={save} />
      <Button ghost label="Cancel" disabled={busy} onPress={cancel} />
      {clear ? <Button ghost danger label="Clear" disabled={off} onPress={clear} /> : null}
    </View>
  )

  /** A field's value with Edit beside it; the value is a link when there is one to open. */
  const shown = (which: 'ticket' | 'pr', label: string | null, none: string, link: string | null): React.JSX.Element => (
    <View style={[ui.row, { justifyContent: 'space-between' }]}>
      {label && link ? (
        <Pressable accessibilityRole="link" accessibilityHint="Opens in the browser" onPress={() => void open(link, which === 'pr')} style={{ flexShrink: 1 }}>
          <Text style={[ui.text, { color: colors.accent }]}>{label}</Text>
        </Pressable>
      ) : (
        <Text style={[label ? ui.text : ui.muted, { flexShrink: 1 }]}>{label ?? none}</Text>
      )}
      <Button ghost label="Edit" disabled={off} onPress={() => edit(which)} />
    </View>
  )

  return (
    <View style={{ gap: 8 }}>
      {heading ? <Text style={ui.heading}>Branch</Text> : null}
      {tags.length ? (
        <>
          <Text style={ui.muted}>Workflow tag</Text>
          <View style={styles.chips}>
            {tags.map((t) => {
              const selected = data?.tag === t.id
              return <TagChip key={t.id} tag={t} selected={selected} disabled={off} onPress={() => void send((conn) => conn.request('branch.setTag', { ...ref, tag: selected ? null : t.id }))} />
            })}
          </View>
        </>
      ) : null}
      {customTags.length ? (
        <>
          <Text style={ui.muted}>Custom tags</Text>
          <View style={styles.chips}>
            {customTags.map((t) => (
              <TagChip
                key={t.id}
                tag={t}
                selected={data?.customTags?.includes(t.id) === true}
                disabled={off}
                onPress={() => void send((conn) => conn.request('branch.setCustomTags', { ...ref, customTags: toggledCustomTags(data?.customTags, t.id) }))}
              />
            ))}
          </View>
        </>
      ) : null}

      <View style={ui.card}>
        <Text style={ui.muted}>Note</Text>
        {editing === 'note' ? (
          <>
            <TextInput
              style={[ui.input, styles.note]}
              value={note.text}
              onChangeText={(value) => setNote((now) => ({ ...now, text: value }))}
              multiline
              autoFocus
              textAlignVertical="top"
              placeholder={`Notes for ${branch}…`}
              placeholderTextColor={colors.placeholder}
              accessibilityLabel="Note"
            />
            {note.conflict ? (
              <>
                <Text style={ui.warn}>The note changed on the server</Text>
                <Text style={note.expected ? ui.text : ui.muted}>{note.expected ?? 'No note'}</Text>
              </>
            ) : null}
            {editorButtons(saveNote, true)}
          </>
        ) : (
          <View style={[ui.row, { justifyContent: 'space-between', alignItems: 'flex-start' }]}>
            <Text style={[data?.note ? ui.text : ui.muted, { flexShrink: 1 }]}>{data?.note || 'No note'}</Text>
            <Button ghost label="Edit" disabled={off} onPress={() => edit('note')} />
          </View>
        )}
      </View>

      <View style={ui.card}>
        <Text style={ui.muted}>Ticket</Text>
        {editing === 'ticket' ? (
          <>
            <TextInput
              style={ui.input}
              value={text}
              onChangeText={type}
              autoFocus
              placeholder="ticket id or URL"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="done"
              onSubmitEditing={saveTicket}
              accessibilityLabel="Ticket"
            />
            {editorButtons(saveTicket, text.trim() !== '', data?.ticket ? () => void sendAndClose((conn) => conn.request('branch.setTicket', { ...ref, ticket: null })) : undefined)}
          </>
        ) : (
          shown('ticket', ticket?.label ?? null, 'No ticket', ticketLink)
        )}
      </View>

      <View style={ui.card}>
        <Text style={ui.muted}>Pull request</Text>
        {editing === 'pr' ? (
          <>
            <TextInput
              style={ui.input}
              value={text}
              onChangeText={type}
              autoFocus
              placeholder={prHosts[0]?.hint ?? 'a pull request link'}
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={savePr}
              accessibilityLabel="Pull request link"
            />
            {editorButtons(savePr, text.trim() !== '', data?.pr ? () => void sendAndClose((conn) => conn.request('branch.setPr', { ...ref, pr: null })) : undefined)}
          </>
        ) : (
          <>
            {shown('pr', data?.pr ? `${pullRequestText(data.pr)}${watchSuffix(data, canWatch.current, prHosts)}` : null, 'No pull request', prLink)}
            {watchOffered(data, canWatch.current, prHosts) ? (
              <View style={[ui.row, { marginTop: 6 }]}>
                <Button ghost label={watch.label} disabled={off} onPress={() => void send((conn) => conn.request('branch.setPrWatch', { ...ref, watch: watch.watch }))} />
              </View>
            ) : null}
          </>
        )}
      </View>
      {error ? <Text style={ui.error}>{error}</Text> : null}
      {hasHistory.current ? (
        <View style={ui.row}>
          {/* The branch goes as a parameter, in a form no link changes (a name can hold "/", "?", "%41"). */}
          <Button
            ghost
            label="History"
            accessibilityLabel={`History of ${branch}`}
            onPress={() => router.push(historyRoute(serverId, projectId, repo.id, branch))}
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 14, borderWidth: 1, paddingVertical: 6, paddingHorizontal: 12 },
  chipText: { fontSize: 13, fontWeight: '600' },
  note: { minHeight: 96, maxHeight: 240 }
})
