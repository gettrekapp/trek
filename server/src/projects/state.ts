// The server's projects in memory. Every change goes through apply(): the
// mutation runs on a clone, and if anything changed the result is published
// as the project's topic (subscribers get the diff) and queued for saving.
import { randomUUID } from 'node:crypto'
import { projectTopic } from '../../../src/shared/model/topics.ts'
import type { Project, ProjectSummary } from '../../../src/shared/model/types'
import type { RemoteRepo } from '../../../src/shared/protocolV2'
import { deepEqual } from '../../../src/shared/sync/jsonDiff.ts'
import { codedError } from '../errors.ts'
import type { TopicHub } from '../topicHub.ts'
import { requireString } from '../validate.ts'
import { collectIds, newProject, projectsUsingRepo } from './model.ts'

export interface ProjectPersistence {
  save(project: Project): void
  remove(projectId: string): void
}

export interface ProjectStateDeps {
  hub: TopicHub
  store: ProjectPersistence
  /** Called when the list of project ids or names changes (the `server` topic) */
  onSummariesChange: () => void
  newId?: () => string
}

export class ProjectState {
  private readonly projects = new Map<string, Project>()
  private readonly deps: ProjectStateDeps
  readonly newId: () => string

  constructor(deps: ProjectStateDeps, initial: Project[] = []) {
    this.deps = deps
    this.newId = deps.newId ?? randomUUID
    for (const project of initial) {
      this.projects.set(project.id, project)
      deps.hub.publish(projectTopic(project.id), project)
    }
  }

  list(): ProjectSummary[] {
    return [...this.projects.values()].map(({ id, name }) => ({ id, name }))
  }

  all(): Iterable<Project> {
    return this.projects.values()
  }

  /** The project; BAD_REQUEST if the id is not a string, NOT_FOUND if unknown. Treat as read-only; change it through apply(). */
  require(projectId: unknown): Project {
    const id = requireString(projectId, 'projectId')
    const project = this.projects.get(id)
    if (!project) throw codedError('NOT_FOUND', `No project with id "${id}"`)
    return project
  }

  /**
   * Runs `mutate` on a copy; publishes (and saves) only if something changed.
   * Returns `mutate`'s result.
   *
   * `persist: false` is for runtime-only fields (git status, session status):
   * the change is published and kept in memory but not written to disk. It
   * reaches disk only with a later persisted change (the store resets runtime
   * fields on load either way).
   */
  apply<T>(projectId: unknown, mutate: (draft: Project) => T, options: { persist?: boolean } = {}): T {
    const current = this.require(projectId)
    const draft = structuredClone(current)
    const result = mutate(draft)
    if (draft.id !== current.id) throw new Error('a mutation must not change the project id')
    if (deepEqual(draft, current)) return result
    this.commit(draft, options.persist ?? true)
    if (draft.name !== current.name) this.deps.onSummariesChange()
    return result
  }

  create(name: string, repositories: { registered: RemoteRepo; name: string | undefined }[]): string {
    const project = newProject(name, repositories, this.newId)
    this.commit(project)
    this.deps.onSummariesChange()
    return project.id
  }

  /** `build` receives the new project id and returns the checked project (see importCheck.ts). */
  importProject(build: (projectId: string) => Project): string {
    const projectId = this.newId()
    const project = build(projectId)
    this.commit(project)
    this.deps.onSummariesChange()
    return projectId
  }

  /** Removes the file first: if that throws, the project stays (in memory and on its topic). */
  delete(projectId: unknown): void {
    const project = this.require(projectId)
    this.deps.store.remove(project.id)
    this.projects.delete(project.id)
    this.deps.hub.drop(projectTopic(project.id))
    this.deps.onSummariesChange()
  }

  /** Names of the projects using the repo at `repoPath`. */
  usage(repoPath: string): string[] {
    return projectsUsingRepo(this.projects.values(), repoPath)
  }

  allIds(): Set<string> {
    const ids = new Set<string>()
    for (const p of this.projects.values()) for (const id of collectIds(p)) ids.add(id)
    return ids
  }

  /** Publishes first, so a publish that throws leaves memory unchanged. */
  private commit(project: Project, persist = true): void {
    this.deps.hub.publish(projectTopic(project.id), project)
    this.projects.set(project.id, project)
    if (persist) this.deps.store.save(project)
  }
}
