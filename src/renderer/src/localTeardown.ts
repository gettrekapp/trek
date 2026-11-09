// A Local server window's worktree delete, on this machine (backendV2's `worktrees.remove` calls
// it as `teardown`): the confirm (with the dev stack's checkbox), a fresh dirty check on this disk,
// then the stack and the branch's Colima VM, before the server removes the worktree.
import { environmentFor, repoOfInfo, useAppStore } from './store'
import { destroyEnvironmentIfAny } from './environmentActions'
import { envRepoKey } from '../../shared/environments'
import type { GitWorktreeInfo } from '../../shared/types'
import type { WorktreeTeardown } from './v2/backendV2'

/** The branch's live environment (environments run on this machine only). */
function environmentOf(info: GitWorktreeInfo): { profile: string } | undefined {
  const state = useAppStore.getState()
  if (!state.project) return undefined
  return environmentFor(state.environments, envRepoKey(repoOfInfo(state.project, info)), info.branch)
}

/** Tear down the worktree's environment, surfacing failures without blocking the caller. */
async function teardownEnvironment(info: GitWorktreeInfo): Promise<void> {
  const project = useAppStore.getState().project
  if (!project) return
  const warning = await destroyEnvironmentIfAny(envRepoKey(repoOfInfo(project, info)), info.branch)
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
  const stack = await window.api.stackStatus(info.path).catch(() => null)
  const stackName = stack?.available && stack.created ? stack.slug : undefined
  if (!stackName) return { confirmed: await window.api.confirm(prompt) }
  const result = await window.api.confirmWithCheckbox({
    ...prompt,
    checkboxLabel: `Also destroy its dev stack “trek-${stackName}” (containers, volumes and its Trek_${stackName.replace(/-/g, '_')} and Cosmos databases)`,
    checkboxChecked: true
  })
  return { confirmed: result.confirmed, stackName: result.checked ? stackName : undefined }
}

/** The teardown for a Local server window's worktree delete (backendV2's `worktrees.remove`): its paths are this machine's. */
export const localWorktreeTeardown: WorktreeTeardown = {
  environment: environmentOf,
  confirm: confirmRemoval,
  destroyStack: teardownStack,
  destroyEnvironment: teardownEnvironment,
  // A Local server window's worktree is on this disk.
  isDirty: worktreeIsDirty
}

/** Fresh dirty check for a worktree on this disk; falls back to the cached flag if the check fails. */
async function worktreeIsDirty(info: GitWorktreeInfo): Promise<boolean> {
  try {
    const dirty = await window.api.localWorktreeDirty(info.path)
    if (dirty !== null) return dirty
  } catch {
    // unreadable — use the cached flag
  }
  return info.dirty ?? false
}
