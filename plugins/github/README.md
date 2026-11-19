# The GitHub plugin

GitHub pull requests for worktree branches (phase 5c-1; a plugin since plugins P3). Its pure
provider (`shared/pr.ts`) reads `https://github.com/<owner>/<repo>/pull/<number>` links in any
form a person pastes, stores them canonically, labels them `#<number>`, and takes a bare number once
another PR in the repository is linked. Its server half reads a PR for the watch (one GraphQL query
with no bodies), checks the sign-in, finds a PR's head branch, and names the ref `git fetch` takes
(`refs/pull/<n>/head`).

Every call goes through `gh` on the server's machine with its own sign-in: run `gh auth login` as
the server's user. The server never holds a GitHub token. Tests and smokes never run the real gh:
`TREK_SERVER_GH` (an absolute path) points the server at a stub (`scripts/smokeGh.mjs`); any other
value fails closed, as though gh were not installed.
