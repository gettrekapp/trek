import { getProvider, isProviderId } from './registry.ts'
import type { LlmSelection } from './types'

const CLAUDE: LlmSelection = { provider: 'claude' }

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * A saved selection, made safe: undefined when there is none, Claude when the provider
 * is unknown (hand-edited or from a newer Trek), and blank model/effort dropped.
 */
export function sanitizeLlmSelection(value: unknown): LlmSelection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (!isProviderId(record.provider)) return { ...CLAUDE }
  const model = text(record.model)
  const effort = text(record.effort)
  return {
    provider: record.provider,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
}

export interface NewSessionSources {
  pick?: LlmSelection
  sessionType?: LlmSelection
  projectDefault?: LlmSelection
  appDefault?: LlmSelection
}

/** The first selection that is set wins as a whole — fields never mix across sources. */
export function resolveNewSessionLlm(sources: NewSessionSources): LlmSelection {
  return (
    sources.pick ?? sources.sessionType ?? sources.projectDefault ?? sources.appDefault ?? { ...CLAUDE }
  )
}

/** The Global panel needs Trek's MCP tools: fall back past providers without them. */
export function resolveGlobalLlm(
  projectGlobal: LlmSelection | undefined,
  sessionDefault: LlmSelection | undefined
): LlmSelection {
  for (const candidate of [projectGlobal, sessionDefault]) {
    if (candidate && getProvider(candidate.provider).capabilities.mcp) return candidate
  }
  return { ...CLAUDE }
}

/** Effort levels on offer for a selection's model. */
export function effortsFor(selection: LlmSelection): string[] {
  const provider = getProvider(selection.provider)
  if (!provider.capabilities.effort) return []
  if (!selection.model) return provider.efforts
  const known = provider.models.find((m) => m.id === selection.model)
  return known ? (known.efforts ?? []) : provider.efforts
}

/** The effort to pass, or undefined when the chosen model doesn't take it. */
export function effectiveEffort(selection: LlmSelection): string | undefined {
  return selection.effort && effortsFor(selection).includes(selection.effort)
    ? selection.effort
    : undefined
}

/** "Codex · gpt-5 · high" */
export function describeLlm(selection: LlmSelection): string {
  const effort = effectiveEffort(selection)
  return [getProvider(selection.provider).label, selection.model, effort].filter(Boolean).join(' · ')
}

/** Whether a saved session's history can follow its worktree to a new path. */
export function sessionMigrates(session: { llm?: LlmSelection }): boolean {
  return getProvider(session.llm?.provider).capabilities.sessionMigration
}

type WithLlm = { llm?: unknown }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanLlm<T>(item: T): T {
  if (!isObject(item)) return item
  const { llm, ...rest } = item
  const clean = sanitizeLlmSelection(llm)
  return (clean ? { ...rest, llm: clean } : rest) as T
}

/** Maps an array's entries; anything that isn't an array is left as is. */
function mapEach<T>(value: T, fn: (item: unknown) => unknown): T {
  return (Array.isArray(value) ? value.map(fn) : value) as T
}

interface ProjectLlmShape {
  llmDefault?: unknown
  globalLlm?: unknown
  sessionTypes?: unknown
  globalSessions?: unknown
  repositories?: unknown
}

function cleanWorktree(w: unknown): unknown {
  if (!isObject(w) || !('terminals' in w)) return w
  return { ...w, terminals: mapEach(w.terminals, cleanLlm) }
}

function cleanRepository(repo: unknown): unknown {
  if (!isObject(repo)) return repo
  return {
    ...repo,
    ...('worktrees' in repo ? { worktrees: mapEach(repo.worktrees, cleanWorktree) } : {}),
    ...('primaryTerminals' in repo
      ? { primaryTerminals: mapEach(repo.primaryTerminals, cleanLlm) }
      : {})
  }
}

/** Sanitizes every LLM selection a loaded project file can hold; malformed shapes pass through. */
export function sanitizeProjectLlm<T extends ProjectLlmShape>(project: T): T {
  const { llmDefault, globalLlm, ...rest } = project
  const cleanDefault = sanitizeLlmSelection(llmDefault)
  const cleanGlobal = sanitizeLlmSelection(globalLlm)
  return {
    ...rest,
    ...(cleanDefault ? { llmDefault: cleanDefault } : {}),
    ...(cleanGlobal ? { globalLlm: cleanGlobal } : {}),
    ...('sessionTypes' in project ? { sessionTypes: mapEach(project.sessionTypes, cleanLlm) } : {}),
    ...('globalSessions' in project
      ? { globalSessions: mapEach(project.globalSessions, cleanLlm) }
      : {}),
    ...('repositories' in project
      ? { repositories: mapEach(project.repositories, cleanRepository) }
      : {})
  } as T
}
