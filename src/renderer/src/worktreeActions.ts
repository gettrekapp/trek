import {
  baseName,
  dormantSessions,
  environmentFor,
  hostRepoPath,
  primaryWorktreeId,
  repoById,
  repoOfInfo,
  useAppStore
} from './store'
import { destroyEnvironmentIfAny } from './environmentActions'
import { createTerminal, disposeTerminal } from './terminals'
import { sameWorktree } from '../../shared/types'
import type { GitWorktreeInfo, PersistedTerminal, WorktreeInstance } from '../../shared/types'
import type { WorktreeTeardown } from './v2/backendV2'
import { persistedLlm, sessionMigrates, sessionsAfterMove } from '../../shared/providers/selection'

/**
 * Sessions whose agent can't follow a worktree to a new path (Codex, Gemini, Grok) are
 * dropped rather than resumed somewhere their history isn't.
 */
function splitMigratable(carried: PersistedTerminal[]): { kept: PersistedTerminal[]; dropped: number } {
  const kept = carried.filter(sessionMigrates)
  return { kept, dropped: carried.length - kept.length }
}

/** Tells the user how many sessions splitMigratable dropped, once they really are gone. */
function notifyDropped(dropped: number): void {
  if (dropped === 0) return
  void window.api.showError(
    'Some sessions could not move',
    `${dropped} session(s) run an agent that keeps its history per folder, so they were closed. Start new ones in the new location.`
  )
}

export type MoveStepKey =
  | 'preflight'
  | 'sessions'
  | 'export'
  | 'push'
  | 'create'
  | 'apply'
  | 'copySessions'
  | 'verify'
  | 'finalize'

export const MOVE_STEPS: { key: MoveStepKey; label: string }[] = [
  { key: 'preflight', label: 'Checking source and target' },
  { key: 'sessions', label: 'Closing Claude sessions' },
  { key: 'export', label: 'Exporting uncommitted changes' },
  { key: 'push', label: 'Pushing branch to origin' },
  { key: 'create', label: 'Creating worktree on target' },
  { key: 'apply', label: 'Applying uncommitted changes' },
  { key: 'copySessions', label: 'Copying Claude sessions' },
  { key: 'verify', label: 'Verifying target' },
  { key: 'finalize', label: 'Resuming sessions & cleaning up source' }
]

export interface MoveProgress {
  (step: MoveStepKey, status: 'active' | 'done' | 'skipped' | 'failed', detail?: string): void
}

/**
 * Symlink the project's linked directories (settings.linkedDirs, e.g. a
 * .trek/ folder of secrets) from the main repo into a fresh worktree.
 * Best-effort — a failure never blocks worktree creation.
 */
export async function linkProjectDirs(
  repoId: string,
  serverId: string | null,
  repoPath: string,
  worktreePath: string
): Promise<void> {
  const project = useAppStore.getState().project
  const dirs = (project && repoById(project, repoId)?.linkedDirs) ?? []
  if (dirs.length === 0) return
  try {
    await window.api.linkWorktreeDirs(serverId, repoPath, worktreePath, dirs)
  } catch (err) {
    console.error('could not link shared directories into worktree', err)
  }
}

/** Where a branch's worktree goes: next to the repo, as <repo>-<branch>. */
export function worktreePathFor(repoPath: string, branch: string): string {
  const repoParent = repoPath.split('/').slice(0, -1).join('/')
  return `${repoParent}/${baseName(repoPath)}-${branch.replace(/[\/\\]/g, '-')}`
}

/**
 * Create a worktree for a branch — a new one cut from the latest default
 * branch, or an existing one — link the project's shared dirs into it and tag
 * it. Returns the worktree's path.
 */
export async function createBranchWorktree(
  repoId: string,
  serverId: string | undefined,
  repoPath: string,
  branch: string,
  createBranch: boolean
): Promise<string> {
  const worktreePath = worktreePathFor(repoPath, branch)
  await window.api.addWorktree(serverId ?? null, repoPath, worktreePath, branch, createBranch)
  await linkProjectDirs(repoId, serverId ?? null, repoPath, worktreePath)
  // Fresh worktrees start with the first workflow tag — unless the branch
  // already carries a tag from an earlier worktree.
  tagNewBranch(repoId, branch)
  return worktreePath
}

/** Give a fresh worktree's branch the first workflow tag, unless it already has one. */
export function tagNewBranch(repoId: string, branch: string): void {
  const state = useAppStore.getState()
  const first = state.project?.worktreeTags?.[0]
  const repo = state.project && repoById(state.project, repoId)
  if (first && repo && !repo.branchTags?.[branch]) state.setBranchTag(repoId, branch, first.id)
}

/**
 * Move a worktree (and its Claude sessions) to another machine. Committed
 * work travels through origin; uncommitted+untracked changes travel as one
 * binary patch; session .jsonl files are copied and only deleted from the
 * source after the target is verified. Nothing destructive happens to the
 * source until the finalize step — any earlier failure rolls the target back
 * and leaves the source exactly as it was (closed terminals resume normally).
 */
export async function moveWorktree(opts: {
  info: GitWorktreeInfo
  instance: WorktreeInstance | undefined
  /** undefined = the local machine */
  targetServerId: string | undefined
  onProgress: MoveProgress
  isCancelled: () => boolean
}): Promise<{ ok: boolean; error?: string; warning?: string }> {
  const { info, instance, targetServerId, onProgress, isCancelled } = opts
  const project = useAppStore.getState().project
  if (!project) return { ok: false, error: 'No project open' }

  const sourceServerId = info.serverId ?? null
  const targetHost = targetServerId ?? null
  const repo = repoOfInfo(project, info)
  const sourceRepo = hostRepoPath(repo, info.serverId)
  const targetRepo = hostRepoPath(repo, targetServerId)
  const branch = info.branch
  const sourcePath = info.path

  let currentStep: MoveStepKey = 'preflight'
  const progress: MoveProgress = (step, status, detail) => {
    if (status === 'active') currentStep = step
    onProgress(step, status, detail)
  }
  const fail = (step: MoveStepKey, error: string): { ok: false; error: string } => {
    onProgress(step, 'failed', error)
    return { ok: false, error }
  }

  // ---- 1. Preflight (read-only) ----
  progress('preflight', 'active')
  if (!branch) return fail('preflight', 'This worktree is on a detached HEAD — check out a branch first.')
  if (!sourceRepo || !targetRepo) return fail('preflight', 'Missing repository path for source or target.')
  if (info.isMain) return fail('preflight', 'The main checkout cannot be moved.')
  let targetWorktrees: GitWorktreeInfo[]
  try {
    targetWorktrees = await window.api.listWorktrees(targetHost, targetRepo)
  } catch (err) {
    return fail('preflight', `Target is unreachable: ${String(err)}`)
  }
  const conflict = targetWorktrees.find((w) => w.branch === branch)
  if (conflict) {
    return fail(
      'preflight',
      `"${branch}" is already checked out on the target at ${conflict.path} — delete that worktree first.`
    )
  }
  const targetPath = worktreePathFor(targetRepo, branch)
  if (targetWorktrees.some((w) => w.path === targetPath)) {
    return fail('preflight', `${targetPath} already exists on the target — delete it first.`)
  }
  progress('preflight', 'done')
  if (isCancelled()) return { ok: false, error: 'Cancelled' }

  // ---- 2. Capture + close sessions (source stays intact on failure —
  //         sessions resume from their still-present .jsonl files) ----
  progress('sessions', 'active')
  // The notice waits for the finalize step: a failed or cancelled move says nothing.
  const { kept: carried, dropped } = splitMigratable(carriedSessions(instance?.id))
  const wasLoaded = isLoaded(instance?.id)
  if (instance) {
    const state = useAppStore.getState()
    for (const terminalId of [...(state.terminalOrder[instance.id] ?? [])]) {
      disposeTerminal(terminalId)
    }
  }
  progress('sessions', carried.length > 0 ? 'done' : 'skipped')
  if (isCancelled()) return { ok: false, error: 'Cancelled' }

  // ---- 3. Export dirty state ----
  progress('export', 'active')
  let patch: string
  let headSha: string
  try {
    const exported = await window.api.exportDirtyPatch(sourceServerId, sourcePath)
    patch = exported.patch
    headSha = exported.headSha
  } catch (err) {
    return fail('export', String(err))
  }
  const hasDirty = patch.trim().length > 0
  progress('export', hasDirty ? 'done' : 'skipped', hasDirty ? undefined : 'working tree clean')
  if (isCancelled()) return { ok: false, error: 'Cancelled' }

  // ---- 4. Push branch through origin ----
  progress('push', 'active')
  try {
    await window.api.pushBranch(sourceServerId, sourcePath, branch)
  } catch (err) {
    return fail(
      'push',
      `Could not push "${branch}" to origin (resolve manually, e.g. diverged history): ${String(err)}`
    )
  }
  progress('push', 'done')
  if (isCancelled()) return { ok: false, error: 'Cancelled' }

  // Anything past here creates state on the target — roll it back on failure.
  const importedSessions: string[] = []
  let targetCreated = false
  const rollback = async (): Promise<void> => {
    try {
      if (targetCreated) await window.api.removeWorktreeForce(targetHost, targetRepo, targetPath)
    } catch (err) {
      console.error('move rollback: could not remove target worktree', err)
    }
    for (const sessionId of importedSessions) {
      try {
        await window.api.deleteClaudeSession(targetHost, targetPath, sessionId)
      } catch (err) {
        console.error('move rollback: could not delete copied session', err)
      }
    }
  }

  try {
    // ---- 5. Create the worktree on the target ----
    progress('create', 'active')
    await window.api.fetchBranch(targetHost, targetRepo, branch)
    await window.api.addWorktreeAt(targetHost, targetRepo, targetPath, branch)
    targetCreated = true
    await linkProjectDirs(repo.id, targetHost, targetRepo, targetPath)
    const targetHead = await window.api.revParseHead(targetHost, targetPath)
    if (targetHead !== headSha) {
      throw new Error(
        `Target checked out ${targetHead.slice(0, 8)} but the source is at ${headSha.slice(0, 8)} — did something else push to "${branch}"?`
      )
    }
    progress('create', 'done')
    if (isCancelled()) throw new Error('Cancelled')

    // ---- 6. Apply the dirty patch ----
    if (hasDirty) {
      progress('apply', 'active')
      await window.api.applyPatch(targetHost, targetPath, patch)
      progress('apply', 'done')
    } else {
      progress('apply', 'skipped')
    }
    if (isCancelled()) throw new Error('Cancelled')

    // ---- 7. Copy Claude session files (copy, not move) ----
    if (carried.length > 0) {
      progress('copySessions', 'active')
      for (const session of carried) {
        const content = await window.api.exportClaudeSession(
          sourceServerId,
          sourcePath,
          session.sessionId
        )
        if (content === null) continue // never used — nothing to carry
        await window.api.importClaudeSession(targetHost, targetPath, session.sessionId, content)
        importedSessions.push(session.sessionId)
      }
      progress('copySessions', 'done', `${importedSessions.length} session file(s)`)
    } else {
      progress('copySessions', 'skipped')
    }
    if (isCancelled()) throw new Error('Cancelled')

    // ---- 8. Verify the target before touching the source ----
    progress('verify', 'active')
    const verifyList = await window.api.listWorktrees(targetHost, targetRepo)
    const created = verifyList.find((w) => w.path === targetPath)
    if (!created || created.branch !== branch) {
      throw new Error('Target worktree missing after creation')
    }
    if (hasDirty) {
      const [status] = await window.api.worktreeStatuses(targetHost, [targetPath])
      if (status?.dirty === false) {
        throw new Error('Uncommitted changes did not survive the transfer')
      }
    }
    progress('verify', 'done')
  } catch (err) {
    await rollback()
    return fail(currentStep, String(err))
  }

  // ---- 9. Point of commitment: update records, resume, clean up source ----
  progress('finalize', 'active')
  let movedInstanceId: string
  if (instance) {
    useAppStore
      .getState()
      .updateWorktreeInstance(instance.id, { path: targetPath, serverId: targetServerId })
    movedInstanceId = instance.id
  } else {
    const created: WorktreeInstance = {
      id: crypto.randomUUID(),
      name: branch,
      path: targetPath,
      serverId: targetServerId,
      branch
    }
    useAppStore.getState().addWorktreeInstance(repo.id, created)
    movedInstanceId = created.id
  }
  await handOverSessions(movedInstanceId, targetPath, carried, wasLoaded, instance?.id)
  notifyDropped(dropped)
  useAppStore.getState().setActiveWorktree(movedInstanceId)

  let warning: string | undefined
  // The source's environment VM must not survive pointing at a deleted path
  // (environments are local-only in v1, so only a local source can have one).
  if (sourceServerId === null && environmentOf(info)) {
    const envWarning = await destroyEnvironmentIfAny(repo.path, branch)
    if (envWarning) warning = `${envWarning} It is listed under Orphaned environments in Settings.`
  }
  try {
    await window.api.removeWorktreeForce(sourceServerId, sourceRepo, sourcePath)
  } catch (err) {
    const removeWarning = `The move succeeded, but the old worktree could not be removed — delete ${sourcePath} from the sidebar later. (${String(err)})`
    warning = warning ? `${warning}\n${removeWarning}` : removeWarning
  }
  for (const sessionId of importedSessions) {
    try {
      await window.api.deleteClaudeSession(sourceServerId, sourcePath, sessionId)
    } catch (err) {
      console.error('could not delete source session file', err)
    }
  }
  progress('finalize', 'done')
  return { ok: true, warning }
}

/**
 * Destructive worktree operations shared by the detail pane's overflow menu.
 * Each confirms via a native dialog and reports failures with an error dialog.
 */

/** The branch's live environment, for local worktrees only (envs are local-only in v1). */
function environmentOf(info: GitWorktreeInfo): { profile: string } | undefined {
  const state = useAppStore.getState()
  if (info.serverId || !state.project) return undefined
  return environmentFor(state.environments, repoOfInfo(state.project, info).path, info.branch)
}

/** Tear down the worktree's environment, surfacing failures without blocking the caller. */
async function teardownEnvironment(info: GitWorktreeInfo): Promise<void> {
  const project = useAppStore.getState().project
  if (!project) return
  const warning = await destroyEnvironmentIfAny(repoOfInfo(project, info).path, info.branch)
  if (warning) {
    await window.api.showError(
      'Environment cleanup failed',
      `${warning}\n\nThe VM is listed under Orphaned environments in Settings.`
    )
  }
}

/** Run stack.sh destroy, surfacing failures without blocking the worktree deletion. */
async function teardownStack(info: GitWorktreeInfo, stackName: string): Promise<void> {
  let failure: string | undefined
  try {
    const code = await window.api.stackDestroy(info.path)
    if (code !== 0) failure = `stack.sh destroy exited with code ${code}.`
  } catch (err) {
    failure = String(err)
  }
  if (failure) {
    await window.api.showError(
      'Dev stack cleanup failed',
      `${failure}\n\nThe worktree is deleted anyway. Remove the leftover stack from any checkout with:\n` +
        `TREK_STACK_NAME=${stackName} docker/stack/stack.sh destroy`
    )
  }
}

type ConfirmPrompt = Parameters<typeof window.api.confirm>[0]

/**
 * Confirm a worktree removal. When the worktree's dev stack has run, the
 * dialog offers to destroy it too; stackName is set when that was ticked.
 */
async function confirmRemoval(
  info: GitWorktreeInfo,
  prompt: ConfirmPrompt
): Promise<{ confirmed: boolean; stackName?: string }> {
  const stack = info.serverId ? null : await window.api.stackStatus(info.path).catch(() => null)
  const stackName = stack?.available && stack.created ? stack.slug : undefined
  if (!stackName) return { confirmed: await window.api.confirm(prompt) }
  const result = await window.api.confirmWithCheckbox({
    ...prompt,
    checkboxLabel: `Also destroy its dev stack “trek-${stackName}” (containers, volumes and its Trek_${stackName.replace(/-/g, '_')} and Cosmos databases)`,
    checkboxChecked: true
  })
  return { confirmed: result.confirmed, stackName: result.checked ? stackName : undefined }
}

/**
 * The same teardown for a Local server window's worktree delete (backendV2's
 * `worktrees.remove`): its paths are this machine's, and its rows have no
 * serverId, so these helpers see it as a local worktree.
 */
export const localWorktreeTeardown: WorktreeTeardown = {
  environment: environmentOf,
  confirm: confirmRemoval,
  destroyStack: teardownStack,
  destroyEnvironment: teardownEnvironment
}

function removeInstance(instanceId: string): void {
  const state = useAppStore.getState()
  for (const terminalId of state.terminalOrder[instanceId] ?? []) disposeTerminal(terminalId)
  state.removeWorktreeInstance(instanceId)
}

/**
 * The sessions a worktree hands over when it is promoted or moved: its live
 * terminals when loaded, else the ones saved in the project file. Only title,
 * session id and agent travel — a remote pty id belongs to the source host.
 */
function carriedSessions(instanceId: string | undefined): PersistedTerminal[] {
  if (!instanceId) return []
  const state = useAppStore.getState()
  const source = state.loadedWorktrees[instanceId]
    ? (state.terminalOrder[instanceId] ?? []).map((id) => state.terminals[id]).filter(Boolean)
    : dormantSessions(state, instanceId)
  // Plain Claude sessions leave `llm` out, as project files always have.
  return source.map(({ title, sessionId, llm }) => {
    const saved = persistedLlm(llm)
    return { title, sessionId, ...(saved ? { llm: saved } : {}) }
  })
}

/**
 * Give the target worktree the carried sessions. They are spawned (resuming
 * each session) when either side is loaded; when an unloaded worktree hands
 * over to an unloaded target they are only recorded, so promoting or moving
 * never starts claude processes the user had deliberately unloaded.
 *
 * `sourceId` is the instance the sessions came from. When it is the target (a move
 * keeps its instance) and nothing is spawned, its own saved list is kept minus the
 * sessions that can't follow — not appended to, which would duplicate the kept ones and
 * bring back the dropped ones — so their prompts, types and queues survive.
 */
async function handOverSessions(
  targetId: string,
  targetPath: string,
  carried: PersistedTerminal[],
  sourceLoaded: boolean,
  sourceId?: string
): Promise<void> {
  const state = useAppStore.getState()
  const spawn = sourceLoaded || !!state.loadedWorktrees[targetId]
  if (targetId === sourceId && !spawn) {
    state.setWorktreeSessions(targetId, sessionsAfterMove(dormantSessions(state, targetId)))
    return
  }
  if (carried.length === 0) return
  if (spawn) {
    for (const session of carried) await createTerminal(targetId, targetPath, session)
    return
  }
  state.setWorktreeSessions(targetId, [...dormantSessions(state, targetId), ...carried])
}

/** Whether a worktree's Claude sessions are currently live. */
function isLoaded(instanceId: string | undefined): boolean {
  return !!instanceId && !!useAppStore.getState().loadedWorktrees[instanceId]
}

/** Fresh dirty check for one worktree; falls back to the cached flag if the check fails. */
async function worktreeIsDirty(info: GitWorktreeInfo): Promise<boolean> {
  try {
    const [status] = await window.api.worktreeStatuses(info.serverId ?? null, [info.path])
    if (status?.dirty !== undefined) return status.dirty
  } catch {
    // host unreachable — use the cached flag
  }
  return info.dirty ?? false
}

export async function deleteWorktree(
  info: GitWorktreeInfo,
  instance: WorktreeInstance | undefined
): Promise<void> {
  const state = useAppStore.getState()
  const project = state.project
  if (!project) return
  const repo = repoOfInfo(project, info)
  const repoPath = hostRepoPath(repo, info.serverId)
  if (!repoPath) return
  const env = environmentOf(info)
  const dirty = await worktreeIsDirty(info)
  const { confirmed, stackName } = await confirmRemoval(info, {
    title: 'Delete Worktree',
    message: `Delete worktree “${info.branch ?? info.path}”?`,
    detail:
      `This runs "git worktree remove" on ${info.path} and deletes the directory. ` +
      `The branch itself is kept. ` +
      (dirty
        ? 'This worktree has uncommitted changes — they will be permanently deleted.'
        : 'Uncommitted changes will block the deletion.') +
      (env
        ? ` Its Docker environment (Colima VM “${env.profile}”) and all its data will also be deleted.`
        : ''),
    confirmLabel: dirty ? 'Delete Worktree & Changes' : 'Delete Worktree'
  })
  if (!confirmed) return
  // Stack and environment first: they need the worktree's files, and their
  // containers hold bind-mount handles into it.
  if (stackName) await teardownStack(info, stackName)
  if (env) await teardownEnvironment(info)
  try {
    if (dirty) await window.api.removeWorktreeForce(info.serverId ?? null, repoPath, info.path)
    else await window.api.removeWorktree(info.serverId ?? null, repoPath, info.path)
  } catch (err) {
    // Changes can appear between the dirty check and the removal — confirm
    // discarding them instead of surfacing a raw git error.
    if (!dirty && /modified or untracked/i.test(String(err))) {
      const discardConfirmed = await window.api.confirm({
        title: 'Delete Uncommitted Changes',
        message: `“${info.branch ?? info.path}” has uncommitted changes.`,
        detail: 'Deleting this worktree will permanently discard them. This cannot be undone.',
        confirmLabel: 'Delete Changes & Worktree'
      })
      if (!discardConfirmed) return
      try {
        await window.api.removeWorktreeForce(info.serverId ?? null, repoPath, info.path)
      } catch (forceErr) {
        await window.api.showError('Could not delete worktree', String(forceErr))
        return
      }
    } else {
      await window.api.showError('Could not delete worktree', String(err))
      return
    }
  }
  if (instance) removeInstance(instance.id)
  const selected = useAppStore.getState().selected
  if (selected && sameWorktree(selected, info)) {
    useAppStore.getState().selectWorktree({ path: repo.path })
  }
}

/**
 * Check the worktree's branch out in the main repo, then delete the worktree.
 * Resolves true when the branch ended up checked out in the main repo.
 */
export async function promoteToPrimary(
  info: GitWorktreeInfo,
  instance: WorktreeInstance | undefined
): Promise<boolean> {
  const project = useAppStore.getState().project
  if (!project) return false
  const repo = repoOfInfo(project, info)
  const repoPath = repo.path
  const primaryId = primaryWorktreeId(repo.id)
  const branch = info.branch
  if (!branch) {
    await window.api.showError(
      'Cannot promote worktree',
      'This worktree is on a detached HEAD — check out a branch in it first.'
    )
    return false
  }
  const env = environmentOf(info)
  const { confirmed, stackName } = await confirmRemoval(info, {
    title: 'Promote to Primary',
    message: `Promote “${branch}” to the primary repository?`,
    detail:
      `The worktree at ${info.path} will be deleted, then "${branch}" will be ` +
      `checked out in the main repository at ${repoPath} (e.g. so your local docker ` +
      `environment runs this branch). Its Claude sessions move to the primary worktree ` +
      `and resume. Uncommitted changes in either checkout will block this.` +
      (env
        ? ` Its Docker environment (Colima VM “${env.profile}”) and all its data will also be deleted.`
        : ''),
    confirmLabel: 'Promote'
  })
  if (!confirmed) return false
  // Uncommitted changes make the removal below fail — find out before
  // destroying the stack, which can't be undone.
  if (stackName && (await worktreeIsDirty(info))) {
    await window.api.showError(
      'Cannot promote worktree',
      `${info.path} has uncommitted changes. Commit or stash them, then promote again.`
    )
    return false
  }
  // Capture the Claude sessions now — they move to the primary worktree
  // after this one is gone.
  const captured = carriedSessions(instance?.id)
  const wasLoaded = isLoaded(instance?.id)
  // Stack and environment first: they need the worktree's files, and their
  // containers hold bind-mount handles into it.
  if (stackName) await teardownStack(info, stackName)
  if (env) await teardownEnvironment(info)
  try {
    // The worktree must go first: git refuses to check out a branch that
    // another worktree already has checked out.
    await window.api.removeWorktree(null, repoPath, info.path)
  } catch (err) {
    await window.api.showError('Could not promote worktree', String(err))
    return false
  }
  let checkedOut = false
  try {
    await window.api.checkoutBranch(null, repoPath, branch)
    checkedOut = true
  } catch (err) {
    await window.api.showError(
      'Worktree deleted, but checkout failed',
      `The worktree was removed but "git checkout ${branch}" failed in ${repoPath}:\n${String(err)}`
    )
  } finally {
    // Kill the worktree terminals before resuming their sessions in the
    // primary — two claude processes must not share one session.
    if (instance) removeInstance(instance.id)
    // Dropped only now: until the worktree was removed, its sessions were still live.
    const { kept: carried, dropped } = splitMigratable(captured)
    notifyDropped(dropped)
    for (const session of carried) {
      // Claude stores sessions per cwd; move each session file into the main
      // repo's project dir or --resume won't find it there.
      try {
        await window.api.migrateClaudeSession(null, session.sessionId, info.path, repoPath)
      } catch (err) {
        console.error('session migration failed', err)
      }
    }
    await handOverSessions(primaryId, repoPath, carried, wasLoaded)
    useAppStore.getState().setActiveWorktree(primaryId)
  }
  return checkedOut
}

/**
 * Move the main checkout's current branch into its own worktree and switch
 * the main repository back to the default branch.
 */
export async function promoteBranchToWorktree(
  repoId: string,
  branch: string | undefined
): Promise<void> {
  const project = useAppStore.getState().project
  const repo = project && repoById(project, repoId)
  if (!repo) return
  const repoPath = repo.path
  const primaryId = primaryWorktreeId(repoId)

  if (!branch) {
    await window.api.showError(
      'Cannot move branch',
      'The main repository is on a detached HEAD — check out a branch first.'
    )
    return
  }
  let defaultBranch: string | null = null
  try {
    defaultBranch = await window.api.getDefaultBranch(null, repoPath)
  } catch {
    // handled below
  }
  if (!defaultBranch) {
    await window.api.showError(
      'Cannot move branch',
      'Could not determine the default branch (master/main) to switch the main repository to.'
    )
    return
  }
  if (branch === defaultBranch) {
    await window.api.showError(
      'Nothing to move',
      `The main repository is already on "${defaultBranch}".`
    )
    return
  }

  const worktreePath = worktreePathFor(repoPath, branch)

  const confirmed = await window.api.confirm({
    title: 'Promote Branch to Worktree',
    message: `Move “${branch}” into its own worktree?`,
    detail:
      `A worktree for "${branch}" will be created at ${worktreePath}, its Claude sessions ` +
      `move to the new worktree (resuming), and the main repository switches back to ` +
      `"${defaultBranch}". Uncommitted changes will block the switch.`,
    confirmLabel: 'Move to Worktree'
  })
  if (!confirmed) return

  try {
    // The main checkout must leave the branch before a worktree can claim it.
    await window.api.checkoutBranch(null, repoPath, defaultBranch)
  } catch (err) {
    await window.api.showError(`Could not switch to ${defaultBranch}`, String(err))
    return
  }
  try {
    await window.api.addWorktree(null, repoPath, worktreePath, branch, false)
  } catch (err) {
    // Roll back so the user isn't silently left on the default branch.
    try {
      await window.api.checkoutBranch(null, repoPath, branch)
    } catch {
      // rollback failed — the error dialog below still explains the state
    }
    await window.api.showError('Could not create worktree', String(err))
    return
  }
  await linkProjectDirs(repoId, null, repoPath, worktreePath)

  // Fresh worktrees start with the first workflow tag — unless the branch
  // already carries a tag from an earlier worktree.
  tagNewBranch(repoId, branch)

  // Carry the primary's Claude sessions into the new worktree.
  const { kept: carried, dropped } = splitMigratable(carriedSessions(primaryId))
  notifyDropped(dropped)
  const primaryWasLoaded = isLoaded(primaryId)
  const state = useAppStore.getState()
  for (const terminalId of [...(state.terminalOrder[primaryId] ?? [])]) {
    disposeTerminal(terminalId)
  }
  // The primary handed its sessions over — clear its saved list either way.
  state.setWorktreeSessions(primaryId, [])

  const instance: WorktreeInstance = {
    id: crypto.randomUUID(),
    name: branch,
    path: worktreePath,
    branch
  }
  useAppStore.getState().addWorktreeInstance(repoId, instance)

  for (const session of carried) {
    try {
      await window.api.migrateClaudeSession(null, session.sessionId, repoPath, worktreePath)
    } catch (err) {
      console.error('session migration failed', err)
    }
  }
  await handOverSessions(instance.id, worktreePath, carried, primaryWasLoaded)
  if (carried.length === 0) await createTerminal(instance.id, worktreePath)
  useAppStore.getState().setActiveWorktree(instance.id)
}
