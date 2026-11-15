// The three top-level screens' bar: Needs you (home, with how many items wait), Projects and
// Servers. Home stays under the other two, so Back from either (and Android's back) leads home;
// between Projects and Servers one replaces the other, so the stack never grows with taps.
import { Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useServers } from '../state/ServersProvider.tsx'
import { colors } from './theme.ts'

export type Tab = 'home' | 'projects' | 'servers'

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'home', label: 'Needs you' },
  { tab: 'projects', label: 'Projects' },
  { tab: 'servers', label: 'Servers' }
]

function go(from: Tab, to: Tab): void {
  if (from === to) return
  if (to === 'home') router.dismissTo('/')
  else if (from === 'home') router.push(to === 'projects' ? '/projects' : '/servers')
  else router.replace(to === 'projects' ? '/projects' : '/servers')
}

export function TabBar({ active }: { active: Tab }): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const waiting = useServers().attention.length
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg, paddingBottom: insets.bottom }}>
      {TABS.map(({ tab, label }) => {
        const on = tab === active
        const badge = tab === 'home' && waiting > 0
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={badge ? `${label}, ${waiting} waiting` : label}
            onPress={() => go(active, tab)}
            style={{ flex: 1, alignItems: 'center', paddingBottom: 10 }}
          >
            <View style={{ width: 24, height: 3, borderRadius: 2, backgroundColor: on ? colors.accent : 'transparent' }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, height: 18 }}>
              <Text style={{ color: on ? colors.text : colors.muted, fontSize: 12, fontWeight: on ? '600' : '400' }}>{label}</Text>
              {badge ? (
                <View style={{ backgroundColor: colors.attention, borderRadius: 8, minWidth: 16, paddingHorizontal: 5, alignItems: 'center' }}>
                  <Text style={{ color: '#1a1300', fontSize: 10, fontWeight: '700', lineHeight: 16 }}>{waiting}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}
