// The session screen's quick buttons: the ones set up on the desktop, in one scrolling row.
// The phone only runs them. ⌨ marks a button that asks for input first, as on the desktop.
import { Pressable, ScrollView, Text } from 'react-native'
import { templateInputs, type TerminalQuickButton } from '../shared.ts'
import { ui } from './theme.ts'

export function QuickButtonRow({ buttons, disabled, onPress }: { buttons: TerminalQuickButton[]; disabled: boolean; onPress: (button: TerminalQuickButton) => void }): React.JSX.Element | null {
  if (!buttons.length) return null
  return (
    <ScrollView horizontal keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 6, paddingHorizontal: 8 }} style={{ flexGrow: 0, marginTop: 6 }}>
      {buttons.map((button) => {
        const label = button.label.trim() || button.text
        const asks = templateInputs(button.text).length > 0
        return (
          <Pressable
            key={button.id}
            accessibilityRole="button"
            accessibilityLabel={asks ? `${label}, asks for input` : label}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => onPress(button)}
            style={({ pressed }) => [ui.ghost, { maxWidth: 200, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
          >
            <Text style={ui.ghostText} numberOfLines={1}>
              {asks ? '⌨ ' : ''}
              {label}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}
