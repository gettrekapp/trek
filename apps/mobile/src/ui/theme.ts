// Colours and shared styles (dark, like the desktop app).
import { StyleSheet } from 'react-native'

export const colors = {
  bg: '#1e1e2e',
  panel: '#262637',
  border: '#3a3a4f',
  text: '#cdd6f4',
  muted: '#9399b2',
  accent: '#89b4fa',
  attention: '#e2a336',
  danger: '#f38ba8',
  ok: '#85d8a3'
}

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  card: { backgroundColor: colors.panel, borderRadius: 10, padding: 12, gap: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  text: { color: colors.text, fontSize: 14 },
  muted: { color: colors.muted, fontSize: 13 },
  warn: { color: colors.attention, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  heading: { color: colors.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginTop: 8 },
  input: { color: colors.text, backgroundColor: colors.panel, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  button: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  buttonText: { color: '#11111b', fontWeight: '600', fontSize: 15 },
  ghost: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  ghostText: { color: colors.text, fontSize: 14 },
  mono: { fontFamily: 'Menlo', fontSize: 12, color: colors.text }
})
