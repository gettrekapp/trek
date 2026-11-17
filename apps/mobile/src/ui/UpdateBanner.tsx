// "Update ready": a downloaded over-the-air update, with Restart (load it now) and Later (it
// loads on the next cold start). Floats near the top, below where a screen's header sits (so it
// never covers Back or a header button), over the content; the bottom has the tab bar and the
// terminal's key bar. A native modal (Add server on iOS) draws over it.
import { Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useOtaUpdate } from '../state/useOtaUpdate.ts'
import { Button } from './Button.tsx'
import { colors, ui } from './theme.ts'

// A stack header's height on a phone (iOS 44, Android 56): the banner sits under it.
const HEADER_HEIGHT = 56

export function UpdateBanner(): React.JSX.Element | null {
  const { visible, restart, dismiss } = useOtaUpdate()
  const insets = useSafeAreaInsets()
  if (!visible) return null
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + HEADER_HEIGHT + 8, left: 12, right: 12, alignItems: 'center' }}>
      <View
        accessibilityRole="alert"
        style={{
          width: '100%',
          maxWidth: 520,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          padding: 12,
          borderRadius: 10,
          backgroundColor: colors.panel,
          borderWidth: 1,
          borderColor: colors.border
        }}
      >
        <Text style={[ui.text, { flex: 1 }]}>Update ready</Text>
        <Button ghost label="Later" onPress={dismiss} />
        <Button label="Restart" onPress={restart} />
      </View>
    </View>
  )
}
