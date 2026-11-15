// The desktop's state marks: an amber "!" needs you, a blue dot is finished and unseen, a green
// arc is working, a hollow ring is idle. 'none' keeps the column, so names line up.
import { Text, View } from 'react-native'
import type { RowMark } from '../logic/worktreeRow.ts'
import { colors } from './theme.ts'

const COLUMN = 16

export function StateMark({ mark }: { mark: RowMark }): React.JSX.Element {
  const box = { width: COLUMN, height: 20, alignItems: 'center', justifyContent: 'center' } as const
  if (mark === 'attention') {
    return (
      <View style={box}>
        <View style={{ width: COLUMN, height: COLUMN, borderRadius: COLUMN / 2, backgroundColor: colors.attention, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#1a1300', fontSize: 11, fontWeight: '700', lineHeight: 14 }}>!</Text>
        </View>
      </View>
    )
  }
  if (mark === 'done') return <View style={box}><View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent }} /></View>
  if (mark === 'working') return <View style={box}><View style={{ width: 11, height: 11, borderRadius: 6, borderWidth: 2, borderColor: colors.ok, borderRightColor: 'transparent' }} /></View>
  if (mark === 'idle') return <View style={box}><View style={{ width: 9, height: 9, borderRadius: 5, borderWidth: 1.5, borderColor: colors.muted }} /></View>
  return <View style={box} />
}
