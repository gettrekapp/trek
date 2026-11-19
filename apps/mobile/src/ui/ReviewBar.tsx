// The Changes screen's draft bar, fixed at the bottom while the draft has comments: how many there
// are, those that are not on the shown diff (tapped: their list, each with Delete), "Send to…" (the
// worktree's sessions; tapping one sends the draft there) and Discard. Send and Discard carry the
// revision of the draft the bar was showing, so nothing unseen is sent or discarded.
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { ReviewComment, ReviewDraft } from '../shared.ts'
import { barText, elsewherePlace, type SendTarget } from '../logic/review.ts'
import { Button } from './Button.tsx'
import { CommentView, useReview } from './CommentBox.tsx'
import { STATUS_TEXT, statusColor } from './status.ts'
import { colors, ui } from './theme.ts'

export function ReviewBar({ draft, elsewhere, targets, noTargets, onSend, onDiscard }: {
  /** The draft as the snapshot has it, with at least one comment */
  draft: ReviewDraft
  /** Its comments that are not on the shown diff: another source, or a file not in it */
  elsewhere: readonly ReviewComment[]
  /** The sessions the draft can be sent to (sendTargets) */
  targets: readonly SendTarget[]
  /** What the list says when there are none (noTargetsText) */
  noTargets: string
  onSend(sessionId: string, revision: number): void
  onDiscard(revision: number, count: number): void
}): React.JSX.Element {
  const { edit, busy, canWrite } = useReview()
  // The session list is open for the draft it was opened on: a draft that changes under it closes
  // it, so a tap sends what the bar said when the list was asked for.
  const [sendFor, setSendFor] = useState<number | null>(null)
  const [listed, setListed] = useState(false)
  const count = draft.comments.length
  const text = barText(count, elsewhere.length)
  const off = busy || !canWrite
  const sending = sendFor === draft.revision
  // A comment being edited is shown even with the list folded (its file left the diff meanwhile).
  const editingElsewhere = edit !== null && elsewhere.some((c) => c.id === edit.commentId)
  const showElsewhere = elsewhere.length > 0 && !sending && (listed || editingElsewhere)
  return (
    <View style={styles.bar}>
      {sending ? (
        <View style={styles.panel}>
          <Text style={ui.muted}>{targets.length === 0 ? noTargets : 'Send the review to'}</Text>
          {targets.length > 0 ? (
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {targets.map((t) => (
                <Pressable
                  key={t.sessionId}
                  accessibilityRole="button"
                  accessibilityLabel={`Send the review to ${t.title}, ${STATUS_TEXT[t.status]}`}
                  accessibilityState={{ disabled: off }}
                  disabled={off}
                  onPress={() => {
                    setSendFor(null)
                    onSend(t.sessionId, draft.revision)
                  }}
                  style={({ pressed }) => [styles.target, { opacity: off ? 0.4 : pressed ? 0.7 : 1 }]}
                >
                  <Text style={[ui.text, { flexShrink: 1 }]}>{t.title}</Text>
                  <Text style={{ color: statusColor(t.status), fontSize: 13 }}>{STATUS_TEXT[t.status]}</Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
        </View>
      ) : null}
      {showElsewhere ? (
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {elsewhere.map((c) => (
            <CommentView key={c.id} comment={c} where={elsewherePlace(c)} editable={false} inList={false} />
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.row}>
        <View style={[ui.row, { flexShrink: 1, flexWrap: 'wrap' }]}>
          <Text style={ui.text}>{text.count}</Text>
          {text.elsewhere !== null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${elsewhere.length} elsewhere: ${elsewhere.length === 1 ? 'a comment' : 'comments'} not on this diff`}
              accessibilityState={{ expanded: showElsewhere }}
              hitSlop={10}
              onPress={() => {
                setSendFor(null)
                setListed(!showElsewhere)
              }}
            >
              <Text style={[ui.text, { color: colors.accent }]}>{text.elsewhere}</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={ui.row}>
          <Button
            label="Send to…"
            disabled={off}
            onPress={() => {
              setListed(false)
              setSendFor(sending ? null : draft.revision)
            }}
          />
          <Button ghost danger label="Discard" disabled={off} onPress={() => onDiscard(draft.revision, count)} />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.panel, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 8, paddingBottom: 8, paddingHorizontal: 16, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  panel: { gap: 6 },
  list: { maxHeight: 220, flexGrow: 0 },
  target: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 44, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }
})
