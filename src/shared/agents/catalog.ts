// The agents a client offers (plugins A2): its server's `server.agents` answer as one catalog. An
// agent the server describes (agentInfo: it carries its capabilities, models and the rest) is
// taken as the server says; one it only names (a server before agentInfo) gets its facts by id
// from the old-server snapshot (legacyAgents.ts, removed with the fallbacks); with no answer at
// all (before it comes, or a server without `agents`), the snapshot is the list. An AgentLookup,
// so the neutral rules (selection.ts) run over it. Pure: the renderer, the web client, desktop
// main's importer and the phone.
import { DEFAULT_AGENT_ID, type AgentApprovalMode, type AgentCapabilities, type AgentModel } from '../plugins/agents.ts'
import type { AgentInfo, ServerAgents } from '../protocolV2.ts'
import { LEGACY_AGENTS, type LegacyAgent } from './legacyAgents.ts'
import { effectiveEffortOf, resolveGlobalAgent, resolveNewSessionLlm, type AgentFacts, type AgentLookup, type AgentSelection } from './selection.ts'

export interface ClientAgent {
  id: string
  label: string
  /** Two letters for a session's tab (fallbackGlyph where the server gave none) */
  glyph: string
  /** The plugin that offers it (agentInfo); undefined from an older server */
  plugin?: string
  /** What the server said; true where it was not asked */
  installed: boolean
  /** On in the window's project (agentInfo with a projectId); true where the server didn't say */
  on: boolean
  capabilities: AgentCapabilities
  models: readonly AgentModel[]
  efforts: readonly string[]
  approvalModes: readonly AgentApprovalMode[]
  defaultApprovalMode?: string
  /**
   * Where its model list comes from: its static `models`; the server (`agents.models`: an
   * endpoint's, Local's); or typed by the user (an endpoint's that the server can't list for a
   * client: a server before agentInfo). Any value but `static` means it has no static models, so
   * none is preselected.
   */
  modelsFrom: 'static' | 'server' | 'typed'
}

export interface AgentCatalog extends AgentLookup {
  /** Every agent listed, in the server's order */
  readonly agents: readonly ClientAgent[]
  /** The ones a new session can use: on in the project */
  readonly offered: readonly ClientAgent[]
  /** A listed agent, or undefined */
  get(id: string | undefined): ClientAgent | undefined
  /** Its label; an id nobody lists is shown as itself; no id is the default agent */
  label(id: string | undefined): string
  /** Its glyph; an id nobody lists gets fallbackGlyph */
  glyph(id: string | undefined): string
  /** Whether a new session may use it in the project; an id nobody lists runs the default agent there, which is always on */
  isOn(id: string): boolean
}

/** A new object each time: a catalog hands out copies, never the snapshot's or the answer's own objects. */
const noCapabilities = (): AgentCapabilities => ({
  presetSessionId: false,
  resume: false,
  mcp: false,
  appendSystemPrompt: false,
  effort: false,
  addDirs: false,
  sessionMigration: false
})

const copyModels = (models: readonly AgentModel[] | undefined): AgentModel[] =>
  (models ?? []).map((m) => ({ ...m, ...(m.efforts ? { efforts: [...m.efforts] } : {}) }))
const copyModes = (modes: readonly AgentApprovalMode[] | undefined): AgentApprovalMode[] => (modes ?? []).map((m) => ({ ...m }))

/** A glyph for an agent without one: the first two letters or digits of its id, upper-cased ("aider" → "AI"). */
export function fallbackGlyph(id: string): string {
  return id.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?'
}

/** The snapshot's agent, copied; an old server's answer may say its label, installed, on and glyph. */
function fromLegacy(l: LegacyAgent, said: { installed: boolean; label?: string; on?: boolean; glyph?: string }): ClientAgent {
  return {
    id: l.id,
    label: said.label ?? l.label,
    glyph: said.glyph || l.glyph,
    installed: said.installed,
    on: said.on !== false,
    capabilities: { ...l.capabilities },
    models: copyModels(l.models),
    efforts: [...l.efforts],
    approvalModes: copyModes(l.approvalModes),
    ...(l.defaultApprovalMode ? { defaultApprovalMode: l.defaultApprovalMode } : {}),
    modelsFrom: l.listsModels ? 'typed' : 'static'
  }
}

function fromServer(a: AgentInfo): ClientAgent {
  if (a.capabilities) {
    return {
      id: a.provider,
      label: a.label,
      glyph: a.glyph || fallbackGlyph(a.provider),
      ...(a.plugin ? { plugin: a.plugin } : {}),
      installed: a.installed,
      on: a.on !== false,
      capabilities: { ...a.capabilities },
      models: copyModels(a.models),
      efforts: [...(a.efforts ?? [])],
      approvalModes: copyModes(a.approvalModes),
      ...(a.defaultApprovalMode ? { defaultApprovalMode: a.defaultApprovalMode } : {}),
      modelsFrom: a.listsModels ? 'server' : 'static'
    }
  }
  // A server before agentInfo: its label, installed, and on and glyph where it says them; the snapshot's facts.
  const legacy = LEGACY_AGENTS.find((l) => l.id === a.provider)
  if (legacy) return fromLegacy(legacy, a)
  return {
    id: a.provider,
    label: a.label,
    glyph: a.glyph || fallbackGlyph(a.provider),
    installed: a.installed,
    on: a.on !== false,
    capabilities: noCapabilities(),
    models: [],
    efforts: [],
    approvalModes: [],
    modelsFrom: 'static'
  }
}

/** The catalog of a `server.agents` answer; null: no answer (the snapshot, all on and none checked). */
export function agentCatalog(server: ServerAgents | null | undefined): AgentCatalog {
  const agents = server ? server.agents.map(fromServer) : LEGACY_AGENTS.map((l) => fromLegacy(l, { installed: true }))
  const byId = new Map(agents.map((a) => [a.id, a]))
  const get = (id: string | undefined): ClientAgent | undefined => (id === undefined ? undefined : byId.get(id))
  const fallback: AgentFacts = get(DEFAULT_AGENT_ID) ?? { capabilities: noCapabilities(), models: [], efforts: [] }
  return {
    agents,
    offered: agents.filter((a) => a.on),
    get,
    has: (id) => byId.has(id),
    facts: (id) => get(id) ?? fallback,
    label: (id) => get(id ?? DEFAULT_AGENT_ID)?.label ?? id ?? DEFAULT_AGENT_ID,
    glyph: (id) => get(id ?? DEFAULT_AGENT_ID)?.glyph ?? fallbackGlyph(id ?? DEFAULT_AGENT_ID),
    isOn: (id) => get(id)?.on ?? true
  }
}

/** "Codex · gpt-5 · high": the agent's label, the model, and the effort where the model takes it. */
export function describeAgent(selection: AgentSelection, catalog: AgentCatalog): string {
  return [catalog.label(selection.provider), selection.model, effectiveEffortOf(selection, catalog)].filter(Boolean).join(' · ')
}

/**
 * The agent a new session started without one gets, as the server resolves it (server/src/sessions/
 * manager.ts defaultLlm, plugins A1b): the project's default, else the server's; for a Global
 * session the project's Global agent first, past agents without Trek's tools. A default whose agent
 * is off in the project is passed over, down to the default agent, which is always on.
 */
export function expectedDefault(
  settings: { llmDefault?: AgentSelection; globalLlm?: AgentSelection },
  serverDefault: AgentSelection,
  catalog: AgentCatalog,
  global: boolean
): AgentSelection {
  const on = (s: AgentSelection | undefined): AgentSelection | undefined => (s && catalog.isOn(s.provider) ? s : undefined)
  const server = on(serverDefault)
  return global
    ? resolveGlobalAgent(on(settings.globalLlm), on(settings.llmDefault) ?? server, catalog)
    : resolveNewSessionLlm({ projectDefault: on(settings.llmDefault), appDefault: server })
}

/** Where a Global panel override starts: the server's default where it has Trek's tools and is offered, else the first offered agent that has them, else the default agent. */
export function globalStart(serverDefault: AgentSelection | undefined, catalog: AgentCatalog): AgentSelection {
  const usable = (id: string): boolean => catalog.offered.some((a) => a.id === id && a.capabilities.mcp)
  if (serverDefault && usable(serverDefault.provider)) return serverDefault
  const first = catalog.offered.find((a) => a.capabilities.mcp)
  return first ? { provider: first.id } : { provider: DEFAULT_AGENT_ID }
}

/** A session tab's glyph: none for the default agent (as before plugins A2), else its glyph and the selection in words. */
export function sessionGlyph(llm: AgentSelection | undefined, catalog: AgentCatalog): { glyph: string; title: string } | null {
  if (!llm || llm.provider === DEFAULT_AGENT_ID) return null
  return { glyph: catalog.glyph(llm.provider), title: describeAgent(llm, catalog) }
}

/** Why a saved choice (a session type's, an automation's, a default) can't start a session now, or null. */
export function agentNote(llm: AgentSelection | undefined, catalog: AgentCatalog): string | null {
  if (!llm) return null
  const agent = catalog.get(llm.provider)
  if (!agent) return `${llm.provider} is not an agent this server has.`
  if (!agent.on) return `${agent.label} is turned off for this project: new sessions can't use it. Pick another agent, or turn it on in Settings → Plugins.`
  return null
}
