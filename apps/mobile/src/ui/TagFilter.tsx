// The worktree list's Tag filter (the project screen and the tablet sidebar), as the desktop
// sidebar's "Tag: All ▾" menu: a chip with the picked tags' colours and, while filtering, a × that
// clears it. The chip opens a sheet: All, the project's workflow tags, its custom tags and
// Untagged; each tag row toggles (the sheet stays open, several can be picked), All clears and
// closes, Done or the backdrop closes. Rules in logic/worktreeFilter.ts; the caller passes the
// cleaned filter.
import { useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ProjectSettings } from '../shared.ts'
import { UNTAGGED, tagFilterLabel, tagFilterOptions, toggledTagFilter } from '../logic/worktreeFilter.ts'
import { colors, ui } from './theme.ts'

function Dot({ color }: { color: string }): React.JSX.Element {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
}

/** One choice in the sheet: its dot (a tag's colour), its name and ✓ while picked. */
function Choice({ name, color, selected, onPress }: { name: string; color?: string; selected: boolean; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [ui.listRow, { alignItems: 'center' }, pressed ? { backgroundColor: colors.panel } : null]}
      onPress={onPress}
    >
      {color ? <Dot color={color} /> : null}
      <Text style={{ flex: 1, color: colors.text, fontSize: 15 }}>{name}</Text>
      {selected ? <Text style={{ color: colors.accent, fontSize: 15 }}>✓</Text> : null}
    </Pressable>
  )
}

export function TagFilter({ settings, filter, onChange }: { settings: ProjectSettings; filter: readonly string[]; onChange: (filter: readonly string[]) => void }): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const [open, setOpen] = useState(false)
  const label = tagFilterLabel(settings, filter)
  const { workflow, custom } = tagFilterOptions(settings)
  const filtering = filter.length > 0
  const close = (): void => setOpen(false)
  const toggle = (id: string): void => onChange(toggledTagFilter(filter, id))
  return (
    <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingTop: 10, gap: 8, alignItems: 'center' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label.text}
        accessibilityHint="Filters the worktrees by tag"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 }, pressed ? { opacity: 0.7 } : null]}
      >
        {label.colors.map((c, i) => (
          <Dot key={i} color={c} />
        ))}
        <Text style={{ color: filtering ? colors.text : colors.muted, fontSize: 13 }}>{label.text} ▾</Text>
      </Pressable>
      {filtering ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear tag filter" hitSlop={10} onPress={() => onChange([])}>
          <Text style={{ color: colors.muted, fontSize: 17 }}>×</Text>
        </Pressable>
      ) : null}
      {open ? (
        <Modal transparent animationType="slide" visible onRequestClose={close}>
          <View style={{ flex: 1, justifyContent: 'flex-end' }}>
            <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} accessible={false} importantForAccessibility="no" onPress={close} />
            <View style={{ backgroundColor: colors.bg, borderTopLeftRadius: 14, borderTopRightRadius: 14, borderTopWidth: 1, borderColor: colors.border, maxHeight: '80%', paddingBottom: insets.bottom }} accessibilityViewIsModal>
              <View style={[ui.row, { justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 }]}>
                <Text accessibilityRole="header" style={ui.title}>
                  Filter by tag
                </Text>
                <Pressable accessibilityRole="button" hitSlop={10} onPress={close}>
                  <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600' }}>Done</Text>
                </Pressable>
              </View>
              <ScrollView>
                <Choice
                  name="All"
                  selected={!filtering}
                  onPress={() => {
                    onChange([])
                    close()
                  }}
                />
                {workflow.map((t) => (
                  <Choice key={t.id} name={t.name} color={t.color} selected={filter.includes(t.id)} onPress={() => toggle(t.id)} />
                ))}
                {custom.length > 0 ? (
                  <View style={ui.section}>
                    <Text style={ui.sectionText}>Custom tags</Text>
                  </View>
                ) : null}
                {custom.map((t) => (
                  <Choice key={t.id} name={t.name} color={t.color} selected={filter.includes(t.id)} onPress={() => toggle(t.id)} />
                ))}
                <View style={{ height: 18 }} />
                <Choice name="Untagged" selected={filter.includes(UNTAGGED)} onPress={() => toggle(UNTAGGED)} />
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  )
}
