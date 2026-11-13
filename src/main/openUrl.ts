import { execFile } from 'node:child_process'
import { shell } from 'electron'

// Matches the URL itself or a sub-page of it (…/pull/12/files), but not a
// longer sibling (…/pull/123).
const FOCUS_CHROME_TAB = `
on run argv
  set target to item 1 of argv
  if application "Google Chrome" is not running then return "no"
  tell application "Google Chrome"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        set u to URL of t
        if u is target or u starts with (target & "/") or u starts with (target & "?") or u starts with (target & "#") then
          set active tab index of w to i
          set index of w to 1
          activate
          return "yes"
        end if
      end repeat
    end repeat
  end tell
  return "no"
end run
`

function focusChromeTab(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', FOCUS_CHROME_TAB, url], { timeout: 3000 }, (err, stdout) =>
      resolve(!err && stdout.trim() === 'yes')
    )
  })
}

/**
 * The URL an open tab must match; Linear issue URLs drop the title slug, which tabs may lack or have
 * stale. (A URL-shape rule in main; the Linear plugin owns Linear's tickets, plugins/linear.)
 */
function tabMatchUrl(url: string): string {
  const linearIssue = url.match(/^(https:\/\/linear\.app\/[^/]+\/issue\/[^/?#]+)/)
  return linearIssue ? linearIssue[1] : url.replace(/\/+$/, '')
}

/** Opens a link in the browser, switching to an already-open Chrome tab for it when there is one. */
export async function openUrl(url: string): Promise<void> {
  if (process.platform === 'darwin' && /^https?:/.test(url)) {
    if (await focusChromeTab(tabMatchUrl(url))) return
  }
  await shell.openExternal(url)
}
