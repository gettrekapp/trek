// A Back chevron for a nested stack's first screen, whose header shows none of its own: it leaves
// the nested stack (the project) for the screen beneath it in the root stack.
import { Pressable, Text } from 'react-native'
import { colors } from './theme.ts'

export function HeaderBack({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Back" hitSlop={12} onPress={onPress} style={{ paddingRight: 8 }}>
      <Text style={{ color: colors.text, fontSize: 30, lineHeight: 32, marginTop: -4 }}>‹</Text>
    </Pressable>
  )
}
