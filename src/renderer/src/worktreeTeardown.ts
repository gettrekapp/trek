// A worktree delete's teardown on the server's machine, on a server without `worktreeTeardown`
// (backendV2's `worktrees.remove` calls it as `teardown`): the confirm (with the dev stack's
// checkbox), a fresh dirty check through the server's git (`worktree.dirty`), then the stack and
// the plugins' parts (their legacyTeardown: the Colima VM), before the server removes the worktree
// (4c's order). Every call goes to the backend
// doing the remove, which it hands each step: a window that leaves mid-confirm sends nothing to
// the next one's. The store and the dialogs come in as deps (installV2.ts), so this file runs
// under node --test. On a server with `worktreeTeardown` (plugins E1) only `confirmPlan` is used:
// the server tears down.
import type { TeardownItem } from '../../shared/teardown.ts'
import type { GitWorktreeInfo } from '../../shared/types'
import type { WindowBackend } from './backend'
import type { ConfirmPrompt, WorktreeTeardown } from './v2/backendV2'

export interface WorktreeTeardownDeps {
  /** What the active plugins tear down themselves (their legacyTeardown), from their own state: the confirm's sentence */
  pluginPart(info: GitWorktreeInfo): { notice: string } | undefined
  /** Tears those down through `backend`: their warnings, instead of a rejection */
  destroyPluginPart(backend: WindowBackend, info: GitWorktreeInfo): Promise<string[]>
  showError(title: string, message: string): Promise<void>
  confirm(prompt: ConfirmPrompt): Promise<boolean>
  confirmWithCheckbox(options: ConfirmPrompt & { checkboxLabel: string; checkboxChecked: boolean }): Promise<{ confirmed: boolean; checked: boolean }>
  /**
   * The plan's items as a checkbox each, in the window (plugins E3, teardownPrompt.ts), with the
   * participants the server could not ask: the ticked ids once confirmed
   */
  confirmTeardown(prompt: ConfirmPrompt, items: readonly TeardownItem[], unplanned: readonly string[]): Promise<{ confirmed: boolean; teardown: string[] }>
}

/** The delete stops here: a timeout says nothing about the worktree's changes, so "clean" is no safe guess. */
export const DIRTY_CHECK_TIMED_OUT =
  "The server did not answer in time when asked whether the worktree has uncommitted changes. Nothing was deleted; try again."

export function createWorktreeTeardown(deps: WorktreeTeardownDeps): WorktreeTeardown {
  return {
    pluginPart: (info) => deps.pluginPart(info),

    // The server's plan, a checkbox per item in the window (teardownPrompt.ts), with the participants
    // it could not ask (plugins E3); no items and none of those: the plain confirm.
    confirmPlan: async (prompt, items, stillWanted, unplanned = []) => {
      if (stillWanted && !stillWanted()) return { confirmed: false, teardown: [] }
      if (items.length === 0 && unplanned.length === 0) return { confirmed: await deps.confirm(prompt), teardown: [] }
      return deps.confirmTeardown(prompt, items, unplanned)
    },

    // When the worktree's dev stack has run, the dialog offers to destroy it too; stackName is set when that was ticked.
    // `stillWanted` false once the stack's status is read: no dialog, not confirmed.
    // Old-server fallback (no worktreeTeardown): remove in a later release.
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
    // Old-server fallback (no worktreeTeardown): remove in a later release.
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

    // The plugins' parts, each failure shown (in the plugin's words) without blocking the caller.
    // Old-server fallback (no worktreeTeardown): remove in a later release.
    destroyPluginPart: async (info, backend) => {
      for (const warning of await deps.destroyPluginPart(backend, info)) await deps.showError('Cleanup failed', warning)
    },

    // A fresh check through the server's git. null (git can't read it) or a failure (a server
    // without worktree.dirty) falls back to the cached flag (Decision 13); a timeout rejects.
    // Old-server fallback (no worktreeTeardown): remove in a later release.
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
