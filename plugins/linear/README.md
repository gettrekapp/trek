# The Linear plugin

Linear issues as branch tickets, and their live status with the server's own API key (phase 5b;
a plugin since plugin system phase 2). Its id is `linear`, so its methods keep their 5b wire names,
and a 0.2.x client that knows only the `linear` capability still works with it (see
[Plugins](../../PROTOCOL.md#plugins)).

- `manifest.ts`: id, version, name, `defaultEnabled: true`, legacy capability `linear`, secret
  `linear`, project setting `linearWorkspace`
- `shared/ticket.ts`: the ticket provider: issue ids (`TOW-123`) and
  `https://linear.app/<workspace>/issue/<ID>…` URLs (implying `linearWorkspace`), links from a
  looked-up issue's URL or the workspace, the id a Linear-style branch name embeds
- `shared/types.ts`: the wire types
- `server/`: the methods, the provider and the workspace's check
- `client/`: the Runtime (key check, issue lookups every 5 minutes and on focus, published to the
  chips), the Settings section (the key), the provider

## Methods

The key is write-only: `linear.setKey` stores it in the server's `secrets.json` under `linear`
(0600, written then renamed; a file that cannot be read or parsed is never overwritten), and no
method sends it back; `linear.status` says only whether one is set. A key is checked first
(Linear's `viewer`); the result is `{ok: false, error}` with Linear's answer when it is refused. A
`secrets.json` that cannot be read is `TOOL_ERROR` before Linear is asked (with `ifAbsent` too), as
is one that cannot be written. `ifAbsent: true` is the desktop's one-time hand-over of its own key
to the Local server: stored unchecked, only while the server has none; otherwise `{ok: false,
error, present: true}` and the server's key is kept. A key is 1 to 1024 printable ASCII characters
with no spaces.

| Method | Params | Result |
|---|---|---|
| `linear.status` | `{}` | `{hasKey}` |
| `linear.setKey` | `{apiKey, ifAbsent?}` | `{ok: true, user}` (the key's Linear user; empty for `ifAbsent`) or `{ok: false, error, present?}` |
| `linear.clearKey` | `{}` | `null` |
| `linear.issues` | `{ids}` (at most 500 strings of at most 64 characters) | the `LinearIssue`s that exist and the key can see; ids that are not `ABC-123` are left out; `[]` without a key |

A failure of Linear (unreachable, a revoked key) is `TOOL_ERROR` with its message. A stored key
(`ok: true`) and `linear.clearKey` send `plugins.changed {id: 'linear'}` and, for 0.2.x clients,
`integrations.changed {linear: true}`; a refused or kept key sends nothing. These answer whether
or not the plugin is on for a project: the key is the server's.

## The project setting

`linearWorkspace`: the slug in `linear.app/<slug>/…` (word characters and hyphens, at most 200),
which turns a bare issue id into a link. A pasted issue URL sets it.

## Off for a project

Its tickets show as the bare id with no link, no issues are looked up, `set_worktree_ticket` refuses
a Linear id or URL, and the link dialog doesn't offer Linear. Branches keep their stored ids.
