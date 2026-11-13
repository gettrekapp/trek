# The voice plugin

Spoken summaries from agent sessions through ElevenLabs, with the server's own API key (phase 5b;
a plugin since plugin system phase 1). Its id is `voice`, so its methods and event keep their 5b
wire names, and a 0.2.x client that knows only the `voice` capability still works with it (see
[Plugins](../../PROTOCOL.md#plugins)).

- `manifest.ts`: id, version, name, `defaultEnabled: true`, legacy capability `voice`, secret `elevenlabs`
- `shared/types.ts`: the wire types
- `server/`: the methods, the `speak_summary` MCP tool, the "Summarize automatically" session prompt
- `client/`: the window's Runtime (playback, Active/Busy), the sidebar toggle, the bubble, the Settings section

## Methods

The key is write-only: `voice.setKey` stores it in the server's `secrets.json` under `elevenlabs`
(0600, written then renamed; a file that cannot be read or parsed is never overwritten), and no
method sends it back; `voice.settings` says only whether one is set. A key is checked first by
listing its voices; the result is `{ok: false, error}` with ElevenLabs' answer when it is refused. A
`secrets.json` that cannot be read is `TOOL_ERROR` before ElevenLabs is asked (with `ifAbsent` too),
as is one that cannot be written; a key that was stored but whose first voice could not be saved is
`TOOL_ERROR` saying so. `ifAbsent: true` is the desktop's one-time hand-over of its own key to the
Local server: stored unchecked, only while the server has none; otherwise `{ok: false, error,
present: true}` and the server's key is kept. A key is 1 to 1024 printable ASCII characters with no
spaces.

| Method | Params | Result |
|---|---|---|
| `voice.settings` | `{}` | `{hasKey, voiceId, modelId, promptSessions}` |
| `voice.setKey` | `{apiKey, ifAbsent?}` | `{ok: true, voices}` (the first one is chosen when no voice is; empty for `ifAbsent`) or `{ok: false, error, present?}` |
| `voice.clearKey` | `{}` | `null` |
| `voice.voices` | `{}` | the key's voices, `[{id, name}]` |
| `voice.setConfig` | any of `{voiceId, modelId, promptSessions}` | the whole config |
| `voice.synthesize` | `{text}` (trimmed, 1 to 400 characters) | `{audio}`: an mp3, base64, for this connection only (Settings' Test) |

A failure of ElevenLabs (unreachable, a revoked key, a quota) is `TOOL_ERROR` with its message. The
config (`<dataDir>/plugins/voice/config.json`; `<dataDir>/voice.json` before plugins, moved at the
plugin's first start) holds no secret. A stored key (`ok: true`), `voice.clearKey` and
`voice.setConfig` send `plugins.changed {id: 'voice'}` and, for 0.2.x clients, `integrations.changed
{voice: true}` to every authenticated connection; a refused or kept key sends nothing.

These answer whether or not the plugin is on for a project: the key and voice are the server's.

## In a project where it is on

**`speak_summary`** (MCP): `terminalId`, `summary` (one to three short sentences, trimmed, at most 400
characters) → `{played: true, windows}` (the connections it went to), or `{played: false, reason}`:
voice is not set up (no key or no voice, or an unreadable secrets file), or no connection has the
project open (nothing is synthesized in either case), or every connection with the project open is
more than 4 MiB behind. A failed synthesis is a tool error. The summary goes as **`voice.summary`**
`{projectId, sessionId, text, audio}` (an mp3, base64) to every connection subscribed to the
project's topic. Whether a client plays it is the client's: the desktop plays it unless its user set
the app to Busy (the plugin's per-app pref `active`, not the server's).

**"Summarize automatically"** (`promptSessions`): every session the server starts that has the MCP
tools gets a prompt telling it to call `speak_summary` when it finishes or waits on the user, while
the server has a key and a voice.

Where the plugin is off, `speak_summary` is not listed (a call is an unknown tool), no session gets
the prompt and no `voice.summary` is sent.
