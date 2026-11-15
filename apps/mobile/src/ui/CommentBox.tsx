// The Changes screen's review comments: the one box a comment is written or edited in, a comment
// as it is shown (its body, Edit and Delete), and what both read from the screen. The rules are
// logic/review.ts'; the requests are the screen's.
import { createContext, useContext, useEffect, useRef, useState, type ComponentRef } from 'react'
import { Keyboard, StyleSheet, Text, TextInput, View } from 'react-native'
import { MAX_REVIEW_BODY, commentAuthorLabel, type NumberedLine, type ReviewComment } from '../shared.ts'
import { canSaveComment, type CommentEdit } from '../logic/review.ts'
import { Button } from './Button.tsx'
import { colors, ui } from './theme.ts'

/** The screen's review callbacks: one object for the screen's life, so a memoised diff never re-renders for them. */
export interface ReviewActions {
  /**
   * The text typed in the open box. It is the screen's (read at Save, and when another box would
   * replace this one) but not its state: typing re-renders the box alone, and a box that is drawn
   * again elsewhere (its line moved on a reload) begins with it.
   */
  text: { current: string }
  /** Opens the box for a new comment on a line of a file of the shown diff */
  openNew(path: string, line: NumberedLine): void
  /** Opens the box on a comment */
  openEdit(comment: ReviewComment): void
  save(): void
  cancel(): void
  /** Deletes a comment, after asking */
  remove(comment: ReviewComment): void
  /** Scrolls the screen's list so the open box, drawn in that list, is in view (it was drawn, or the keyboard came up) */
  reveal(box: ComponentRef<typeof View>): void
}

/** What changes as the user works on the review; read only by the comments, the box and the bar. */
export interface ReviewUi {
  /** The comment being edited, if the open box is an edit */
  edit: CommentEdit | null
  /** A review request is in flight */
  busy: boolean
  /** The server is connected: comments can be written, changed and sent */
  canWrite: boolean
  actions: ReviewActions
}

export const ReviewContext = createContext<ReviewUi | null>(null)

export function useReview(): ReviewUi {
  const review = useContext(ReviewContext)
  if (!review) throw new Error('A review comment is drawn outside the Changes screen')
  return review
}

/**
 * The open comment box: the text, Save and Cancel. `conflict` is the comment's body on the server
 * after it refused an edit because the comment changed meanwhile: shown under the user's text,
 * which the next Save puts in its place. `inList` false is a box drawn outside the screen's list (in
 * the bar, which is always on screen): the list is not scrolled for it.
 */
export function CommentBox({ conflict, inList = true }: { conflict?: string; inList?: boolean }): React.JSX.Element {
  const { busy, canWrite, actions } = useReview()
  const [text, setText] = useState(() => actions.text.current)
  const box = useRef<ComponentRef<typeof View>>(null)
  const show = (): void => {
    if (inList && box.current) actions.reveal(box.current)
  }
  // The keyboard comes up over the box that was just opened under the tapped line.
  useEffect(() => {
    if (!inList) return
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      if (box.current) actions.reveal(box.current)
    })
    return () => shown.remove()
  }, [actions, inList])
  return (
    <View ref={box} collapsable={false} onLayout={show} style={styles.box}>
      <TextInput
        style={[ui.input, styles.input]}
        value={text}
        onChangeText={(value) => {
          actions.text.current = value
          setText(value)
        }}
        multiline
        autoFocus
        maxLength={MAX_REVIEW_BODY}
        textAlignVertical="top"
        placeholder="Comment on this line"
        placeholderTextColor="#6c7086"
        accessibilityLabel="Comment"
      />
      {conflict !== undefined ? (
        <>
          <Text style={ui.warn}>The comment changed on the server</Text>
          <Text style={ui.text}>{conflict}</Text>
        </>
      ) : null}
      <View style={[ui.row, { marginTop: 6 }]}>
        <Button label="Save" disabled={busy || !canWrite || !canSaveComment(text)} onPress={actions.save} />
        <Button ghost label="Cancel" disabled={busy} onPress={actions.cancel} />
      </View>
    </View>
  )
}

/**
 * A comment of the draft: where it was written (`where`, for one not under its line), its body,
 * Edit and Delete; the box in its place while it is edited. `editable` false leaves Edit out (the
 * bar's "elsewhere" list); `inList` false is a comment drawn outside the screen's list (the same
 * list), whose box the screen's list is not scrolled to.
 */
export function CommentView({ comment, where, editable = true, inList = true }: { comment: ReviewComment; where?: string; editable?: boolean; inList?: boolean }): React.JSX.Element {
  const { edit, busy, canWrite, actions } = useReview()
  const off = busy || !canWrite
  const author = commentAuthorLabel(comment)
  return (
    <View style={styles.comment}>
      {where ? <Text style={ui.muted}>{where}</Text> : null}
      {author ? <Text style={ui.muted}>{author}</Text> : null}
      {edit?.commentId === comment.id ? (
        <CommentBox conflict={edit.conflict ? edit.expected : undefined} inList={inList} />
      ) : (
        <>
          <Text style={ui.text}>{comment.body}</Text>
          <View style={[ui.row, { marginTop: 4 }]}>
            {editable ? <Button ghost label="Edit" disabled={off} onPress={() => actions.openEdit(comment)} /> : null}
            <Button ghost danger label="Delete" disabled={off} onPress={() => actions.remove(comment)} />
          </View>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { paddingVertical: 6, gap: 4 },
  input: { minHeight: 72, maxHeight: 180 },
  comment: { backgroundColor: colors.bg, borderRadius: 8, borderLeftWidth: 3, borderLeftColor: colors.accent, paddingVertical: 8, paddingHorizontal: 10, marginVertical: 4, gap: 4 }
})
