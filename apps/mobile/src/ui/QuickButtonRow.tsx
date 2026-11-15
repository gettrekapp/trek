// The session screen's quick buttons: the ones set up on the desktop, in one scrolling row of
// quiet chips. The phone only runs them. A trailing … marks a button that asks for input first,
// as on the desktop. `leading` is put first in the row (the Keys toggle), and keeps the row
// there when the project has no quick buttons.
import { Pressable, ScrollView, Text } from 'react-native'
import { templateInputs, type TerminalQuickButton } from '../shared.ts'
import { ui } from './theme.ts'

export function QuickButtonRow({ buttons, disabled, onPress, leading }: { buttons: TerminalQuickButton[]; disabled: boolean; onPress: (button: TerminalQuickButton) => void; leading?: React.ReactNode }): React.JSX.Element | null {
  if (!buttons.length && !leading) return null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 6, paddingHorizontal: 12 }} style={{ flexGrow: 0, marginTop: 8 }}>
      {leading}
      {buttons.map((button) => {
        const label = button.label.trim() || button.text.replace(/\s+/g, ' ').trim().slice(0, 60)
        const asks = templateInputs(button.text).length > 0
        return (
          <Pressable
            key={button.id}
            accessibilityRole="button"
            accessibilityLabel={asks ? `${label}, asks for input` : label}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => onPress(button)}
            style={({ pressed }) => [ui.chip, { maxWidth: 200, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
          >
            <Text style={ui.chipText} numberOfLines={1}>
              {label}
              {asks ? '…' : ''}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}
