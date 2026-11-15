// One expanded file of the Changes screen's review: its patch as numbered lines (old and new
// number, the line, coloured), a commentable line a button that opens the comment box under it,
// each line's comments under it, and the comments whose line changed (or all of them, with no
// patch shown) in a box at the top. Where things sit is logic/review.ts' fileReview.
//
// A large patch: the lines are plain rows inside a horizontal scroller inside the screen's vertical
// ScrollView. A FlatList there would not window: a vertical VirtualizedList inside a plain vertical
// ScrollView has no viewport of its own (React Native warns that this breaks windowing), and the
// horizontal scroller between the two does not change that. So at most the first MAX_LINES_SHOWN
// lines are drawn until "Show all <n> lines" is tapped (logic/review.ts' lineCap), and the rows are
// memoised: a save, a delete or an opened box re-renders only the rows it touches.
import { createContext, memo, useContext, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { missingPatchNote, numberedLines, patchBody, reviewLineText, type ChangedFile, type NumberedLine, type ReviewComment } from '../shared.ts'
import { canComment, commentPlace, fileReview, gutter, lineCap, type NewComment } from '../logic/review.ts'
import { Button } from './Button.tsx'
import { CommentBox, CommentView } from './CommentBox.tsx'
import { colors, ui } from './theme.ts'

const LINE_COLOR: Record<NumberedLine['kind'], string> = { add: colors.ok, del: colors.danger, hunk: colors.accent, note: colors.muted, context: colors.text }
const MARKER: Record<NumberedLine['kind'], string> = { add: '+', del: '-', context: ' ', hunk: '', note: '' }

/**
 * Where a comment or the box sits in the horizontally scrolling diff: as wide as the part of it on
 * screen, and from its left edge as last scrolled to, so a comment on a long line is not left
 * behind off screen. A margin, not a transform, so a touch lands where the comment is drawn.
 */
const PlaceContext = createContext({ left: 0, width: 0 })

function InView({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { left, width } = useContext(PlaceContext)
  return <View style={{ marginLeft: left, width }}>{children}</View>
}

/** One diff line with its comments, and the new comment's box when it is written here. */
const Row = memo(function Row({ line, path, oldNumber, newNumber, numberWidth, comments, writingHere, canWrite, onOpen }: {
  line: NumberedLine
  path: string
  oldNumber: number | null
  newNumber: number | null
  numberWidth: number
  comments: readonly ReviewComment[] | undefined
  writingHere: boolean
  canWrite: boolean
  onOpen(path: string, line: NumberedLine): void
}): React.JSX.Element {
  const cells = (
    <>
      <Text style={[styles.number, { width: numberWidth }]}>{oldNumber ?? ''}</Text>
      <Text style={[styles.number, { width: numberWidth }]}>{newNumber ?? ''}</Text>
      <Text style={[ui.mono, { color: LINE_COLOR[line.kind] }]}>{`${MARKER[line.kind]}${line.text}` || ' '}</Text>
    </>
  )
  const count = comments?.length ?? 0
  return (
    <View>
      {canComment(line) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Comment on ${commentPlace({ side: line.side, line: line.line, lineText: reviewLineText(line.text) })}${count > 0 ? `, ${count} ${count === 1 ? 'comment' : 'comments'}` : ''}`}
          accessibilityHint="Opens a comment box under the line"
          accessibilityState={{ disabled: !canWrite }}
          disabled={!canWrite}
          onPress={() => onOpen(path, line)}
          style={({ pressed }) => [styles.line, styles.commentable, count > 0 || writingHere ? styles.marked : null, pressed ? styles.pressed : null]}
        >
          {cells}
        </Pressable>
      ) : (
        <View style={styles.line}>{cells}</View>
      )}
      {comments?.map((c) => (
        <InView key={c.id}>
          <CommentView comment={c} />
        </InView>
      ))}
      {writingHere ? (
        <InView>
          <CommentBox />
        </InView>
      ) : null}
    </View>
  )
})

/**
 * Its props stay the same across a save, a delete or an opened edit (`writing` is the new comment's
 * box, and `editingId` the edited comment, only for the file it is on), and across typing, so the
 * rows are not drawn again for those.
 */
export const FileDiff = memo(function FileDiff({ file, patch, loading, failed, comments, writing, editingId, canWrite, onOpen }: {
  file: ChangedFile
  /** The file's patch for the shown source; undefined while it loads, when it failed, and when there is none */
  patch: string | undefined
  loading: boolean
  /** Why the patch could not be read; null when it was, or is still loading */
  failed: string | null
  /** This file's comments on the shown source (draftOnDiff's entry) */
  comments: readonly ReviewComment[]
  /** The new comment being written on this file (writingOn), if any */
  writing: NewComment | null
  /** The id of the comment being edited, when it is one of this file's `comments`; null otherwise */
  editingId: string | null
  canWrite: boolean
  /** Opens the box for a new comment on a line of this file */
  onOpen(path: string, line: NumberedLine): void
}): React.JSX.Element {
  const numbered = useMemo(() => (patch === undefined ? undefined : numberedLines(patchBody(patch))), [patch])
  const note = file.binary
    ? 'Binary file changed'
    : file.tooLarge
      ? 'File too large to show'
      : file.unreadable
        ? "File can't be read"
        : patch === undefined
          ? missingPatchNote(file, { loading, diffError: failed !== null })
          : null
  // Only a shown patch can say a comment's line changed; otherwise the box at the top just holds them.
  const lines = note === null ? numbered : undefined
  const review = useMemo(() => fileReview(comments, lines, writing), [comments, lines, writing])
  const numbers = useMemo(() => (lines ? gutter(lines) : []), [lines])
  const numberWidth = useMemo(() => {
    let most = 0
    for (const n of numbers) most = Math.max(most, n.old ?? 0, n.new ?? 0)
    return String(most).length * 8 + 6
  }, [numbers])
  const [showAll, setShowAll] = useState(false)
  const cap = lineCap(review, lines?.length ?? 0, showAll, editingId)

  // The part of the diff on screen: its width (the window's, less the screen's and the card's
  // padding, until it is measured) and how far it is scrolled to the right, once a scroll ends.
  const screen = useWindowDimensions()
  const [width, setWidth] = useState<number | null>(null)
  const [left, setLeft] = useState(0)
  const place = useMemo(() => ({ left, width: width ?? Math.max(0, screen.width - 58) }), [left, width, screen.width])
  const scrolled = (e: NativeSyntheticEvent<NativeScrollEvent>): void => setLeft(Math.max(0, Math.round(e.nativeEvent.contentOffset.x)))

  return (
    <View style={styles.file}>
      {review.topTitle !== null ? (
        <View style={styles.top}>
          <Text style={lines ? ui.warn : ui.muted}>{review.topTitle}</Text>
          {review.top.map((c) => (
            <CommentView key={c.id} comment={c} where={commentPlace(c)} />
          ))}
          {review.newOnTop && writing ? (
            <View>
              <Text style={ui.muted}>{commentPlace(writing)}</Text>
              <CommentBox />
            </View>
          ) : null}
        </View>
      ) : null}
      {lines ? (
        // Both scrollers take a tap with the keyboard up: one tap on Save, or on another line.
        <ScrollView
          horizontal
          bounces={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.grow}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          onScrollEndDrag={scrolled}
          onMomentumScrollEnd={scrolled}
        >
          <PlaceContext.Provider value={place}>
            <View style={styles.grow}>
              {lines.slice(0, cap.shown).map((line, i) => (
                // Keyed by side and number, so a line a reload moves keeps its row.
                <Row
                  key={line.side && line.line !== undefined ? `${line.side}${line.line}` : `${line.kind}${i}`}
                  line={line}
                  path={file.path}
                  oldNumber={numbers[i].old}
                  newNumber={numbers[i].new}
                  numberWidth={numberWidth}
                  comments={review.byLine.get(i)}
                  writingHere={i === review.newAt}
                  canWrite={canWrite}
                  onOpen={onOpen}
                />
              ))}
            </View>
          </PlaceContext.Provider>
        </ScrollView>
      ) : (
        <>
          <Text style={ui.muted}>{note}</Text>
          {failed !== null ? <Text style={ui.error}>{failed}</Text> : null}
        </>
      )}
      {cap.more !== null ? <Button ghost label={cap.more} onPress={() => setShowAll(true)} /> : null}
    </View>
  )
})

const styles = StyleSheet.create({
  file: { marginTop: 6, gap: 6 },
  top: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, padding: 8, gap: 4 },
  grow: { flexGrow: 1 },
  line: { flexDirection: 'row', alignItems: 'center', borderLeftWidth: 3, borderLeftColor: 'transparent', paddingRight: 8 },
  // A line that takes a comment is a tap target of at least 28 pt.
  commentable: { minHeight: 28 },
  marked: { borderLeftColor: colors.accent, backgroundColor: 'rgba(137, 180, 250, 0.14)' },
  pressed: { backgroundColor: 'rgba(137, 180, 250, 0.28)' },
  number: { fontFamily: 'Menlo', fontSize: 11, color: colors.muted, textAlign: 'right', paddingRight: 6 }
})
