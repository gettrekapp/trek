// A quick button that needs something first: its {INPUT} fields, and the [built-ins] that have
// no value in this session, with a preview of the text that Send sends. Empty fields are blank
// in the text, as on the desktop.
import { useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { fillTemplate, parseTemplate, type BuiltinValues, type QuickButtonPlan, type TerminalQuickButton } from '../shared.ts'
import { Button } from './Button.tsx'
import { colors, ui } from './theme.ts'

export function QuickButtonSheet({ button, plan, builtins, onSend, onClose }: { button: TerminalQuickButton; plan: QuickButtonPlan; builtins: BuiltinValues; onSend: (text: string) => void; onClose: () => void }): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [filled, setFilled] = useState<Record<string, string>>({})
  const text = fillTemplate(parseTemplate(button.text), inputs, { ...builtins, ...filled })
  const fields = [
    ...plan.inputs.map((name) => ({ key: `{${name}}`, name, missing: false })),
    ...plan.missing.map((name) => ({ key: `[${name}]`, name, missing: true }))
  ]
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, justifyContent: 'flex-end' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} accessibilityLabel="Cancel" onPress={onClose} />
        <View style={{ backgroundColor: colors.bg, borderTopLeftRadius: 14, borderTopRightRadius: 14, borderTopWidth: 1, borderColor: colors.border, maxHeight: '80%', paddingBottom: insets.bottom }}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={ui.pad}>
            <Text style={ui.title}>{button.label.trim() || 'Quick button'}</Text>
            {fields.map((f, i) => (
              <View key={f.key} style={{ gap: 4 }}>
                <Text style={ui.muted}>
                  {f.key}
                  {f.missing ? ' no value here' : ''}
                </Text>
                <TextInput
                  style={ui.input}
                  autoFocus={i === 0}
                  autoCapitalize="none"
                  accessibilityLabel={f.name}
                  value={(f.missing ? filled : inputs)[f.name] ?? ''}
                  onChangeText={(value) => (f.missing ? setFilled : setInputs)((prev) => ({ ...prev, [f.name]: value }))}
                />
              </View>
            ))}
            <Text style={ui.heading}>Preview</Text>
            <Text style={ui.mono}>{text}</Text>
            <View style={[ui.row, { justifyContent: 'flex-end' }]}>
              <Button ghost label="Cancel" onPress={onClose} />
              <Button
                label="Send"
                onPress={() => {
                  onSend(text)
                  onClose()
                }}
              />
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
