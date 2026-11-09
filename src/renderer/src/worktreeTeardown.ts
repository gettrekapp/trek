// A worktree delete's teardown on the server's machine (backendV2's `worktrees.remove` calls it as
// `teardown`, with the `stacks` and `env` features): the confirm (with the dev stack's checkbox),
// a fresh dirty check through the server's git (`worktree.dirty`), then the stack and the branch's
// Colima VM, before the server removes the worktree (4c's order).
import { environmentFor, repoOfInfo, useAppStore } from './store'
import { destroyEnvironmentIfAny } from './environmentActions'
import { getBackend } from './backend'
import { envRepoKey } from '../../shared/environments'
import type { GitWorktreeInfo } from '../../shared/types'
import type { WorktreeTeardown } from './v2/backendV2'

/** The branch's live environment, from the environments poll. */
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
    const code = await getBackend().stacks.destroy({ path: info.path })
    if (code !== 0) failure = `stack.sh destroy exited with code ${code}.`
  } catch (err) {
    failure = String(err)
  }
  if (failure) {
    await window.api.showError(
      'Dev stack cleanup failed',
      `${failure}\n\nThe worktree is deleted anyway. Remove the leftover stack from any checkout on the server's machine with:\n` +
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
  const stack = await getBackend()
    .stacks.status({ path: info.path })
    .catch(() => null)
  const stackName = stack?.available && stack.created ? stack.slug : undefined
  if (!stackName) return { confirmed: await window.api.confirm(prompt) }
  const result = await window.api.confirmWithCheckbox({
    ...prompt,
    checkboxLabel: `Also destroy its dev stack “trek-${stackName}” (containers, volumes and its Trek_${stackName.replace(/-/g, '_')} and Cosmos databases)`,
    checkboxChecked: true
  })
  return { confirmed: result.confirmed, stackName: result.checked ? stackName : undefined }
}

/** Fresh dirty check through the server's git; falls back to the cached flag if the check fails. */
async function worktreeIsDirty(info: GitWorktreeInfo): Promise<boolean> {
  try {
    const dirty = await getBackend().git.dirty({ path: info.path })
    if (dirty !== null) return dirty
  } catch {
    // unreadable, or a server without worktree.dirty: use the cached flag
  }
  return info.dirty ?? false
}

export const worktreeTeardown: WorktreeTeardown = {
  environment: environmentOf,
  confirm: confirmRemoval,
  destroyStack: teardownStack,
  destroyEnvironment: teardownEnvironment,
  isDirty: worktreeIsDirty
}
