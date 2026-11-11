// A worktree's changes (6a), read-only: the branch against its base (the desktop's default view),
// each file's patch on tap. No review comments on the phone.
import { useCallback, useEffect, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import type { WorktreeChanges } from '../../../../src/shared.ts'
import { errorMessage, useServer } from '../../../../src/state/hooks.ts'
import { classifyDiff } from '../../../../src/logic/diff.ts'
import { colors, ui } from '../../../../src/ui/theme.ts'

const LINE_COLOR = { add: colors.ok, del: colors.danger, hunk: colors.accent, meta: colors.muted, context: colors.text }

export default function ChangesScreen(): React.JSX.Element {
  const { serverId, projectId, worktreeId } = useLocalSearchParams<{ serverId: string; projectId: string; worktreeId: string }>()
  const server = useServer(serverId)
  const [changes, setChanges] = useState<WorktreeChanges | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [patches, setPatches] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!server) return
    setLoading(true)
    setError(null)
    try {
      setChanges(await server.connection.request('worktree.changes', { projectId, worktreeId }))
      setPatches({})
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [server, projectId, worktreeId])
  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (path: string): Promise<void> => {
    if (open === path) return setOpen(null)
    setOpen(path)
    if (patches[path] !== undefined || !server) return
    try {
      const result = await server.connection.request('worktree.diff', { projectId, worktreeId, paths: [path] })
      setPatches((p) => ({ ...p, [path]: result[path] ?? '' }))
    } catch (err) {
      setPatches((p) => ({ ...p, [path]: `Could not read the diff: ${errorMessage(err)}` }))
    }
  }

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.pad} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
      {error ? <Text style={ui.error}>{error}</Text> : null}
      {changes ? <Text style={ui.muted}>{changes.base ? `Against ${changes.base}, with the uncommitted work` : 'Uncommitted work'}</Text> : null}
      {changes && changes.files.length === 0 ? <Text style={ui.muted}>No changes.</Text> : null}
      {changes?.files.map((f) => (
        <View key={f.path} style={ui.card}>
          <Pressable accessibilityRole="button" onPress={() => void toggle(f.path)}>
            <Text style={ui.text}>{f.path}</Text>
            <Text style={ui.muted}>
              {f.status}
              {f.binary ? ' · binary' : ` · +${f.added} −${f.deleted}`}
            </Text>
          </Pressable>
          {open === f.path ? (
            <ScrollView horizontal>
              <View>
                {patches[f.path] === undefined ? <Text style={ui.muted}>Loading…</Text> : null}
                {classifyDiff(patches[f.path] ?? '').map((line, i) => (
                  <Text key={i} style={[ui.mono, { color: LINE_COLOR[line.kind] }]}>
                    {line.text || ' '}
                  </Text>
                ))}
              </View>
            </ScrollView>
          ) : null}
        </View>
      ))}
    </ScrollView>
  )
}
