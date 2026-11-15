// Colours and shared styles: the desktop app's own dark palette. Colour is for a session's state
// and the user's tag colours; the rest is text.
import { StyleSheet } from 'react-native'

export const colors = {
  bg: '#111113',
  panel: '#1a1a1e',
  border: '#2a2a2f',
  text: '#ededf0',
  muted: '#9a9aa2',
  placeholder: '#6b6b73',
  accent: '#0a8dff',
  attention: '#e2a336',
  danger: '#ff8589',
  ok: '#5fbf7f'
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
  buttonText: { color: '#ffffff', fontWeight: '600', fontSize: 15 },
  ghost: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  ghostText: { color: colors.text, fontSize: 14 },
  // A list row: full width, a hairline under it, its mark in a fixed column.
  listRow: { flexDirection: 'row', gap: 12, paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  section: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6 },
  sectionText: { color: colors.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  // A quiet filled button for a row of them (quick buttons, keys): no border, so the row reads as one strip.
  chip: { backgroundColor: colors.panel, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  chipText: { color: colors.text, fontSize: 13 },
  mono: { fontFamily: 'Menlo', fontSize: 12, color: colors.text }
})
