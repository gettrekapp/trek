# Worktree Changes Tab

## Goal

Show a worktree's git changes in its detail view: a tab whose title summarises
the changes, and a panel listing each file with its diff.

## Scope of "changes"

Everything this worktree would add to the default branch: commits since the
merge-base with `defaultBaseBranch`, plus staged, unstaged and untracked files.

- No default branch found: compare to `HEAD` (uncommitted changes only), and the
  panel header says so.
- On the default branch itself: unpushed commits plus uncommitted work.

## Tab

A `panel-btn` in the session row next to Notes, using the existing `panel` state
in `WorktreeDetail`. Available on every worktree, local and remote.

- Title: `3 files +42 −7` (`1 file` when singular).
- Title is `Changes` when there are no changes, before counts load, or on error.
- Clicking toggles the panel, as Notes does.

## Panel

Read-only: no staging or reverting.

- Header: the comparison base, e.g. `compared to origin/master`.
- One row per file: path, status (added, modified, deleted, renamed) and `+/−`
  counts. Renames show the old path too.
- Each row expands to a coloured unified diff. Rows start expanded, except files
  with more than 1,500 changed lines, which start collapsed.
- Binary files show "Binary file changed" instead of a diff.
- Empty state: "No changes".

## Git layer (`src/host/gitService.ts`)

### `worktreeChanges(path)`

Returns `{ base, files: [{ path, oldPath?, status, added, deleted, binary, tooLarge?, unreadable? }] }`.
`base` is the default branch name, or `null` when comparing to `HEAD`.

- Tracked changes: one `git --no-optional-locks diff -M -z --raw --numstat <ref> --`,
  giving status and counts from a single snapshot and a single rename scan. This
  covers commits and tracked working-tree edits in one diff.
- Untracked files: `git ls-files --others --exclude-standard -z`, status `added`.
  Text line counts come from the file's line count. Files containing a NUL byte
  in their first 8 KB are binary.
- Untracked files over 5 MB are not read on each poll. They are reported with
  `tooLarge: true` and no line counts, and the panel says "File too large to show".
- Untracked files that cannot be read (for example mode 000) do not fail the
  summary. They are reported with `unreadable: true` and no line counts, and the
  panel says "File can't be read".
- Nested repositories listed as untracked directories have no lines of their own
  and are left out.
- `path` is unique. A tracked deletion plus an untracked file at the same path (for
  example after `git rm --cached`) is one `modified` row with both counts.
- A repository with no commits, or an orphan branch, has no `HEAD`: `<ref>` is the
  empty tree, and `base` is `null`.

### `worktreeDiff(path)`

Returns the patch text per file, keyed by path. Fetched only while the panel is
open.

- Tracked: `git diff -M <ref> --`, split by file.
- Untracked: `git diff --no-index -- /dev/null <file>`, which never touches the
  index. It exits 1 when files differ, so that exit code is treated as success.
- A path that is both a tracked deletion and an untracked file gets both patches,
  concatenated.

Parsing is in pure, separately tested functions. Both functions are wired through
`shared/protocol.ts`, `LocalHost`, `RemoteHost`, `main/project.ts` and preload.

## Refreshing

- Only the selected worktree is polled, every 5 seconds, so large projects don't
  run a diff for every worktree.
- The diff is re-fetched only when the summary changes while the panel is open.
- Polling pauses while the server is disconnected.
- A response for a previously selected worktree is discarded.

## Errors

- Git failure: the tab falls back to `Changes` and the panel shows the error.
- A remote daemon without these calls is handled the same way.

## Testing

- `node --test` cases against a real temporary repo: commits, staged and unstaged
  edits, untracked, renamed and binary files, filenames with spaces, and no base
  branch.
- A check in the running app that the tab and panel work.
