// A worktree delete's teardown on the server's machine (backendV2's `worktrees.remove` calls it as
// `teardown`, with the `stacks` and `env` features): the confirm (with the dev stack's checkbox),
// a fresh dirty check through the server's git (`worktree.dirty`), then the stack and the branch's
// Colima VM, before the server removes the worktree (4c's order). Every call goes to the backend
// doing the remove, which it hands each step: a window that leaves mid-confirm sends nothing to
// the next one's. The store and the dialogs come in as deps (installV2.ts), so this file runs
// under node --test.
import type { GitWorktreeInfo } from '../../shared/types'
import type { WindowBackend } from './backend'
import type { ConfirmPrompt, WorktreeTeardown } from './v2/backendV2'

export interface WorktreeTeardownDeps {
  /** The branch's live environment, from the environments poll */
  environment(info: GitWorktreeInfo): { profile: string } | undefined
  /** Deletes the branch's VM through `backend`; a warning instead of a rejection */
  destroyEnvironment(backend: WindowBackend, info: GitWorktreeInfo): Promise<string | undefined>
  showError(title: string, message: string): Promise<void>
  confirm(prompt: ConfirmPrompt): Promise<boolean>
  confirmWithCheckbox(options: ConfirmPrompt & { checkboxLabel: string; checkboxChecked: boolean }): Promise<{ confirmed: boolean; checked: boolean }>
}

/** The delete stops here: a timeout says nothing about the worktree's changes, so "clean" is no safe guess. */
export const DIRTY_CHECK_TIMED_OUT =
  "The server did not answer in time when asked whether the worktree has uncommitted changes. Nothing was deleted; try again."

export function createWorktreeTeardown(deps: WorktreeTeardownDeps): WorktreeTeardown {
  return {
    environment: (info) => deps.environment(info),

    // When the worktree's dev stack has run, the dialog offers to destroy it too; stackName is set when that was ticked.
    // `stillWanted` false once the stack's status is read: no dialog, not confirmed.
    confirm: async (info, prompt, backend, stillWanted) => {
      const stack = await backend.stacks.status({ path: info.path }).catch(() => null)
      // Read again right before the dialog: an agent's request may have ended meanwhile.
      if (stillWanted && !stillWanted()) return { confirmed: false }
      const stackName = stack?.available && stack.created ? stack.slug : undefined
      if (!stackName) return { confirmed: await deps.confirm(prompt) }
      const result = await deps.confirmWithCheckbox({
        ...prompt,
        checkboxLabel: `Also destroy its dev stack “trek-${stackName}” (containers, volumes and its Trek_${stackName.replace(/-/g, '_')} and Cosmos databases)`,
        checkboxChecked: true
      })
      return { confirmed: result.confirmed, stackName: result.checked ? stackName : undefined }
    },

    // stack.sh destroy, its failure shown without blocking the worktree's deletion (or its promote).
    destroyStack: async (info, stackName, backend, action = 'delete') => {
      let failure: string | undefined
      try {
        const code = await backend.stacks.destroy({ path: info.path })
        if (code !== 0) failure = `stack.sh destroy exited with code ${code}.`
      } catch (err) {
        failure = String(err)
      }
      if (failure) {
        await deps.showError(
          'Dev stack cleanup failed',
          `${failure}\n\n${action === 'promote' ? 'The promote goes on anyway (the worktree is deleted with it).' : 'The worktree is deleted anyway.'} Remove the leftover stack from any checkout on the server's machine with:\n` +
            `TREK_STACK_NAME=${stackName} docker/stack/stack.sh destroy`
        )
      }
    },

    // The VM, its failure shown without blocking the caller.
    destroyEnvironment: async (info, backend) => {
      const warning = await deps.destroyEnvironment(backend, info)
      if (warning) await deps.showError('Environment cleanup failed', `${warning}\n\nThe VM is listed under Orphaned environments in Settings.`)
    },

    // A fresh check through the server's git. null (git can't read it) or a failure (a server
    // without worktree.dirty) falls back to the cached flag (Decision 13); a timeout rejects.
    isDirty: async (info, backend) => {
      try {
        const dirty = await backend.git.dirty({ path: info.path })
        if (dirty !== null) return dirty
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === 'TIMEOUT') throw new Error(DIRTY_CHECK_TIMED_OUT)
      }
      return info.dirty ?? false
    }
  }
}
