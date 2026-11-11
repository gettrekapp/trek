import { Pressable, Text } from 'react-native'
import { ui } from './theme.ts'

export function Button({ label, onPress, disabled, ghost, danger }: { label: string; onPress: () => void; disabled?: boolean; ghost?: boolean; danger?: boolean }): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [ghost ? ui.ghost : ui.button, { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
    >
      <Text style={[ghost ? ui.ghostText : ui.buttonText, danger ? { color: '#f38ba8' } : null]}>{label}</Text>
    </Pressable>
  )
}
