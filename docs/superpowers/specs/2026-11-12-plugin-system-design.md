# Plugin system — phase 1: the contract, with ElevenLabs voice as the first plugin

Date: 2026-11-12
Status: approved design, awaiting implementation plans (P1 voice, P2 Linear)

## Goal

Give Trek one plugin contract that first-party plugins use today and installable, trusted plugins
use later, and prove it by moving the ElevenLabs voice summaries — today spread over ~20 files in
the server, protocol, renderer and desktop main — into a self-contained `plugins/voice/`. Linear
follows on the same contract (P2) to show the contract is not voice-shaped.

### Decisions

| Question | Decision |
| --- | --- |
| Trust model | First-party built-ins now; installable *trusted* (full Node, no sandbox) later, on the same contract |
| Scope of this spec | The contract + voice (P1) + Linear (P2). Runtime loading of installable plugins is a later spec |
| Client UI | Plugins ship React components for named slots, with a scoped host API (ESM bundles sharing Trek's React later) |
| Wire protocol | Namespaced `<pluginId>.*` methods/events on the existing socket; voice keeps id `voice`, so `voice.*` is unchanged on the wire and 0.2.x clients/servers keep working |
| Enablement | Per project. Setup (keys, voice, model) stays per server; the project's *use* of the plugin is toggled |
| Code layout | Top-level `plugins/<id>/` folder per plugin, statically imported via `builtin*.ts` lists |

### Out of scope

Runtime loading of installable plugins; sandboxing; mobile slots (mobile has no voice); per-project
keys; turning the desktop's one-time integrations hand-over into a plugin.

## Layout

```
plugins/
  builtin.server.ts        the server's built-in list
  builtin.client.ts        the renderer's and web client's built-in list
  voice/
    manifest.ts            id, version, name, description, defaultEnabled, legacyCapability, secrets
    shared/protocol.ts     its method/param/result/event maps (moved out of protocolV2.ts)
    shared/types.ts        VoiceInfo, VoiceKeyResult, VoiceServerConfig, VoiceServerSettings, ...
    server/index.ts        the ServerPlugin: handlers, speak_summary tool, session prompt
    server/voiceService.ts (from src/host/voiceService.ts)
    client/index.tsx       the ClientPlugin: Runtime + slots
    client/*               voice.ts, voicePresence.ts, SummaryBubble, VoiceToggle, VoiceSettings, store
    README.md              the voice protocol section (moved from PROTOCOL.md)
  linear/ ...              (P2)
src/shared/plugins/        the contract: manifest.ts, server.ts, client.ts
server/src/plugins/        registry, router hookup, per-project enablement, data-file migration
src/renderer/src/plugins/  client registry, PluginHostProvider, PluginSlot, Plugins settings section
```

### Boundary rule

Code under `plugins/` may import only `src/shared/plugins/*`, `src/shared/*` (types and pure
helpers), its own folder, and npm packages (React, Zustand). It may not import `server/src`,
`src/main`, `src/renderer`, `src/host` or another plugin. Core may import from `plugins/` only in
`plugins/builtin.*.ts`'s consumers (the registries). `scripts/pluginBoundaries.test.mjs` enforces
this by scanning imports; it is what makes a later move to packages a loader change only.

## The manifest

```ts
// src/shared/plugins/manifest.ts
export interface PluginManifest {
  id: string                 // /^[a-z][a-z0-9-]{0,31}$/, also the method namespace ('voice')
  version: string            // semver
  name: string               // 'Voice summaries'
  description: string
  defaultEnabled: boolean    // for a project with no plugins[id] entry
  legacyCapability?: string  // advertised in welcome.capabilities for 0.2.x clients ('voice')
  secrets?: string[]         // the secrets.json names it may use (['elevenlabs'])
}
```

The id must not collide with a core namespace (`project`, `session`, `worktree`, `plugins`, ...);
the registry refuses one that does.

## Server contract

```ts
// src/shared/plugins/server.ts
export interface ServerPlugin<Methods, Events> {
  manifest: PluginManifest
  setup(host: ServerPluginHost<Events>): PluginInstance<Methods>
}

export interface ServerPluginHost<Events> {
  id: string
  secret(name: string): KeySlot              // only names in manifest.secrets; else throws
  dataFile(name: string): string             // <dataDir>/plugins/<id>/<name>, directory created 0700
  testEndpoint(envName: string): string | undefined  // loopback-only override (today's testEndpoint)
  emit<E extends keyof Events>(projectId: string, event: E, data: Events[E]): number
                                             // `<id>.<event>` to the project's subscribers; 0 when disabled there
  subscriberCount(projectId: string): number
  isEnabled(projectId: string): boolean
  changed(): void                            // plugins.changed { id } (and integrations.changed for legacy)
  sessionIn(projectId: string, terminalId: unknown): { session: SessionRef }  // MCP helper from tools.ts
  log: { info(msg: string): void; warn(msg: string): void }
}

export interface PluginInstance<Methods> {
  handlers: { [M in keyof Methods]: (params: unknown, ctx: PluginCallContext) => unknown }
  mcpTools?: PluginMcpTool[]                 // { definition, call(args, { projectId, signal }) }
  mcpInstructions?: string                   // a sentence appended to the trek-dev instructions
  sessionPrompt?(projectId: string): string | undefined
  dispose?(): void
}

export interface PluginCallContext { projectId?: string }  // the connection's project, if any
```

### Core behaviour (`server/src/plugins/`)

- **Registry.** Built from `plugins/builtin.server.ts` at startup. A `setup` that throws is logged
  and that plugin is skipped; the server still starts. Duplicate or reserved ids are refused.
- **Router.** In `v2.ts`, a method `x.y` with no core handler goes to plugin `x`'s handler `y`.
  No such plugin or handler: the existing unknown-method error. Authentication is the connection's,
  as for core methods (the server has no per-method roles). Errors pass through `viaService`
  (service failures become `TOOL_ERROR`; `BAD_REQUEST`/`NOT_FOUND` pass through).
- **Server-level vs project-scoped.** Handlers work whatever a project's enablement (setup is
  per server). MCP tools, `sessionPrompt`, `mcpInstructions` and `emit` apply only where the plugin
  is enabled for the project.
- **Enablement.** A new optional `ProjectSettings.plugins: { [id]: { enabled: boolean } }`
  (`settings.ts` kind `object`, validated: known ids only, boolean `enabled`). Missing entry =
  `manifest.defaultEnabled`. Changing it emits `plugins.changed { id, projectId }` to the project's
  subscribers.
- **welcome.** Gains `plugins: [{ id, version, enabled }]` for the connection's project (every
  registered plugin, with its enablement there). `capabilities` keeps each enabled plugin's
  `legacyCapability`; it is left out where the plugin is disabled, so 0.2.x clients hide it too.
- **Events.** New `plugins.changed { id, projectId? }` (no `projectId`: server-level state such as a
  key changed). `host.changed()` also sends `integrations.changed { [legacyCapability]: true }` for
  0.2.x clients.
- **MCP.** `tools/list` for a project = core tools + enabled plugins' tools; a call to a plugin tool
  in a project where it is disabled is refused as unknown. The instructions text = core text +
  enabled plugins' `mcpInstructions`.
- **Sessions.** `SessionManager`'s `voicePrompt` becomes `pluginPrompts(projectId): string[]`,
  joined into the launch prompt as `VOICE_SUMMARY_PROMPT` is today.

### What leaves core

- `src/host/voiceService.ts` → `plugins/voice/server/voiceService.ts`.
- The `voice.*` handlers and their validation (`integrationHandlers.ts`) → `plugins/voice/server`.
  `integrationHandlers.ts` keeps Linear and skills until P2.
- `speak_summary` (definition + call) and `ToolDeps.voice` leave `server/src/mcp/tools.ts`; its
  sentence leaves the core instructions.
- `VOICE_SUMMARY_PROMPT` leaves `src/shared/providers/prompts.ts`.
- `Integrations.voice`, `VOICE_CONFIG_FILE` and the `voiceConfigFile`/`elevenLabsApi` options leave
  `integrations.ts`/`index.ts`; the plugin reads `TREK_SERVER_ELEVENLABS_URL` via `host.testEndpoint`.
- The voice types and maps leave `protocolV2.ts` and `src/shared/types.ts` for
  `plugins/voice/shared/`. `protocolV2.ts`'s method/event maps are extended by intersection with
  each built-in plugin's maps so the typed client stays typed.

## Client contract

```ts
// src/shared/plugins/client.ts
export interface ClientPlugin {
  manifest: PluginManifest
  Runtime?: React.FC                    // mounted once per window while present and enabled
  slots?: {
    settings?: { title: string; Component: React.FC }
    sidebarFooter?: React.FC
    overlay?: React.FC
  }
}

export interface ClientPluginHost<Methods, Events> {
  request<M extends keyof Methods>(method: M, params: Params<M>): Promise<Result<M>>  // `<id>.<method>`
  onEvent<E extends keyof Events>(event: E, fn: (data: Events[E]) => void): () => void
  onChanged(fn: () => void): () => void // plugins.changed for this id; integrations.changed on legacy servers
  enabled: boolean                      // for this window's project
  setEnabled(on: boolean): Promise<void>
  prefs: {                              // per app: appSettings.plugins[id]
    get<T>(key: string, fallback: T): T
    set(key: string, value: unknown): Promise<void>
    onChange(fn: () => void): () => void
  }
}
// usePluginHost<Methods, Events>() inside any of the plugin's components
```

### Core behaviour (`src/renderer/src/plugins/`)

- **Registry** reads `plugins/builtin.client.ts`; both `App.tsx` and `WebApp.tsx` use it.
- **Presence.** `PluginHostProvider` matches client plugins with `welcome.plugins`. Absent on the
  server → no Runtime, no slots. Server with no `welcome.plugins` (0.2.x): a plugin whose
  `legacyCapability` is in `capabilities` is present and enabled. This replaces `features.voice`
  (and `backendFeatures.ts`'s voice entries).
- **Slots.** `<PluginSlot name="sidebarFooter" />`, `"overlay"` and the Settings sections render each
  present, enabled plugin's component inside its host context and an error boundary: a crash hides
  that plugin's slot and logs, the window stays up. Runtime gets the same boundary.
- **Plugins settings section.** Lists every plugin the client knows with: an on/off switch for this
  project; "Needs a newer server" when the client
  knows it but the server does not list it; "This server doesn't support plugins yet" (switches
  hidden) on a 0.2.x server. Each enabled plugin's own settings section follows, in built-in order.
- **Prefs.** `AppSettings` gains `plugins: Record<string, Record<string, unknown>>`. On load,
  `voiceActive` (if present) is copied to `plugins.voice.active` and dropped, once. The web client's
  appSettings shim gets the same field.
- **Test hook.** `window.__onVoiceSummary` (main.tsx) becomes
  `window.__onPluginEvent(id, event, fn)` for the smokes.

### What leaves core

- `src/renderer/src/voice.ts`, `voicePresence.ts`, `components/SummaryBubble.tsx`,
  `components/VoiceToggle.tsx`, `components/VoiceSettings.tsx` → `plugins/voice/client/`.
  (`audio.ts` is the attention alerts', not voice's; it stays.)
- The store's `voice`, `voiceActive`, `voicePlaying`, `voiceQueued` and setters → a Zustand store in
  `plugins/voice/client/store.ts`.
- `backend.voice` leaves `backend.ts` (the plugin uses `host.request`/`onEvent`).
- `useVoice()` and `<SummaryBubble/>` in `App.tsx`/`WebApp.tsx` become `<PluginRuntimes/>` and
  `<PluginSlot name="overlay"/>`; `{features.voice && <VoiceToggle/>}` in `Sidebar.tsx` becomes
  `<PluginSlot name="sidebarFooter"/>`; SettingsPanel's voice sections become the plugin sections.

## Compatibility

- Wire unchanged for voice: `voice.settings`, `voice.setKey`, `voice.clearKey`, `voice.voices`,
  `voice.setConfig`, `voice.synthesize`, event `voice.summary`.
- New client ↔ 0.2.x server: presence via the `voice` capability (above).
- 0.2.x client ↔ new server: `capabilities` still lists `voice` where enabled; `integrations.changed
  { voice }` still sent. Turning voice off for a project hides it from 0.2.x clients too.
- `scripts/client-contract.mjs` gains a 0.2.1-shaped check: `welcome.capabilities` includes `voice`,
  and the `voice.*` calls answer as before.

## Migration

- **Server config file.** On first start, the voice plugin moves `<dataDir>/voice.json` to
  `<dataDir>/plugins/voice/config.json`: copy, fsync, then remove the old one. If the copy fails the
  old file is read (and the move retried next start); if only the removal fails, the new file wins
  and a warning is logged.
- **Secret.** Stays in `secrets.json` under `elevenlabs` (already namespaced); listed in the manifest.
- **Project settings.** `plugins` is optional; no rewrite of existing projects.
- **App settings.** `voiceActive` → `plugins.voice.active`, once (above).

## Desktop main (stays in core, for now)

- `integrationsHandover.ts`/`integrationsHandoverRules.ts` stay unchanged: a one-time legacy
  hand-over that calls the same `voice.setKey`/`voice.setConfig` wire methods. Removing it is a
  later cleanup.
- `botSecretFiles.ts` (`elevenlabs.json`) and `TREK_SERVER_ELEVENLABS_URL` in `localServerRules.ts`'s
  `KEPT` stay, with a comment naming the voice plugin as their owner.

## Error handling

- Plugin `setup` throws → logged, plugin skipped, server starts; clients see it absent.
- Plugin handler throws → `viaService` mapping; never crashes the connection.
- Plugin MCP tool throws → the tool's error result, as core tools do.
- Client component or Runtime throws → error boundary hides that plugin's UI, logs to console.
- `plugins` settings value malformed (unknown id, non-boolean) → `BAD_REQUEST` from settings
  validation.

## Testing

Existing voice tests move with the code and keep their assertions: `serverIntegrations`,
`serverMcpTools`, `voicePresence`, `backendFeatures`, `v2Backend`, `appSettings`,
`serverTopicHub`, `serverV2`, `webClient` (re-pointed imports / adjusted for `features.voice`'s
removal).

New unit tests:
- Registry: setup throwing skips the plugin; duplicate and reserved ids refused.
- Router: `x.y` dispatch; unknown plugin/method; reserved namespaces not shadowed.
- Enablement: MCP tools listed/callable, `sessionPrompt`, `mcpInstructions` and `emit` gated per
  project; `welcome.plugins`; legacy capability dropped when disabled; `plugins.changed` sent.
- Settings validation of `plugins`.
- Config file migration (move; copy failure; removal failure).
- App settings migration of `voiceActive`.
- Client: `PluginHostProvider` presence with and without `welcome.plugins`; slot error boundary.
- `pluginBoundaries.test.mjs`.

Smokes (temp `--user-data-dir`, the ElevenLabs stub, no real services):
`server-integrations-smoke` and `local-features-smoke` keep voice end to end, plus a step that
turns voice off for the project and checks `speak_summary` leaves `tools/list` and the bubble
does not show; `client-contract` gains the 0.2.1-shaped check.

## Phasing

- **P1 (first plan):** contract (`src/shared/plugins`), server registry/router/enablement, client
  registry/slots/Plugins section, the voice plugin, migrations, boundary test, PROTOCOL.md update.
- **P2 (second plan):** Linear onto the same contract (`linear.*`, its settings section, the
  worktree ticket lookups). Contract fixes it calls for land there.
- **Later specs:** installable trusted plugins (on-disk manifest, package loader, ESM client
  bundles sharing Trek's React, protocol-range check); deleting the integrations hand-over.
