// One worktree as a row: the project's list and, on a wide window, its sidebar draw the same row.
// Its mark, branch, primary, git's dirty mark and counts, saved sessions, then its branch's tag, custom
// tags, ticket and pull request on a line — or the reason it wants you.
import { Pressable, Text, View } from 'react-native'
import type { PrProvider, ProjectSettings, Repository, TicketProvider, Worktree } from '../shared.ts'
import { branchParts } from '../logic/worktreeList.ts'
import { rowGit, rowLabel, rowMark, rowReason, rowSaved } from '../logic/worktreeRow.ts'
import { StateMark } from './StateMark.tsx'
import { colors, ui } from './theme.ts'

export function WorktreeRow(props: {
  settings: ProjectSettings
  repo: Repository
  worktree: Worktree
  trackers: readonly TicketProvider[]
  /** The PR providers on for the project (activePrProviders), for the PR's label */
  prHosts: readonly PrProvider[]
  selected?: boolean
  onPress: () => void
}): React.JSX.Element {
  const { settings, repo, worktree: wt, trackers, prHosts, selected, onPress } = props
  const name = wt.branch ?? wt.name
  const mark = rowMark(wt)
  const git = rowGit(wt)
  const saved = rowSaved(wt)
  const reason = rowReason(wt)
  const parts = reason ? [] : branchParts(settings, repo, wt.branch, trackers, prHosts)
  const line = reason ? reason.text : parts.map((p) => p.text).join(' · ')
  // A row that wants you is bold; one with nothing loaded is quieter.
  const wants = mark === 'attention' || mark === 'done' || !!reason
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={rowLabel({ name, isMain: wt.isMain, mark, saved, git, line })}
      accessibilityState={selected === undefined ? undefined : { selected }}
      style={({ pressed }) => [ui.listRow, selected ? { backgroundColor: colors.panel } : null, pressed ? { backgroundColor: colors.panel } : null]}
      onPress={onPress}
    >
      <StateMark mark={mark} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: wants ? '600' : '500', color: mark === 'none' && !reason ? colors.muted : colors.text }}>
            {name}
          </Text>
          {wt.isMain ? <Text style={{ color: colors.muted, fontSize: 12 }}>primary</Text> : null}
          {git?.dirty ? <Text style={{ color: colors.text, fontSize: 10 }}>●</Text> : null}
          {git?.counts ? <Text style={{ color: colors.muted, fontSize: 12 }}>{git.counts}</Text> : null}
          {saved ? <Text style={{ color: colors.muted, fontSize: 12 }}>▸{saved}</Text> : null}
        </View>
        {reason ? (
          <Text numberOfLines={1} style={{ fontSize: 13, color: reason.kind === 'missing' ? colors.danger : colors.attention }}>
            {reason.text}
          </Text>
        ) : parts.length ? (
          <Text numberOfLines={1} style={ui.muted}>
            {parts.map((part, i) => (
              <Text key={i}>
                {i > 0 ? ' · ' : ''}
                <Text style={part.color ? { color: part.color } : null}>{part.text}</Text>
              </Text>
            ))}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}
