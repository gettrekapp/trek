// Automations' v2 methods: saving, deleting and running one now, and the missed-runs answer a
// window sends (PROTOCOL.md, "Automations"). Every change is on the project (`automations`), so
// the project topic carries it to every window.
import { codedError } from '../errors.ts'
import { requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'
import { MAX_AUTOMATIONS, checkInput, clearMissed, deleteAutomation, saveAutomation } from './model.ts'
import type { AutomationScheduler } from './scheduler.ts'

type Handler = (params: any, ctx: V2Context) => unknown

function scheduler(ctx: V2Context): AutomationScheduler {
  if (!ctx.automations) throw codedError('TOOL_ERROR', 'this server runs no automations')
  return ctx.automations
}

function idList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_AUTOMATIONS || value.some((v) => typeof v !== 'string' || v === '')) {
    throw codedError('BAD_REQUEST', `${field} must be a list of at most ${MAX_AUTOMATIONS} automation ids`)
  }
  return value
}

export const automationHandlers: Record<string, Handler> = {
  'automation.save': (p, ctx) => {
    const s = scheduler(ctx)
    const now = s.now()
    const input = checkInput(p.automation, now)
    return ctx.projects.apply(p.projectId, (d) => {
      const { list, id } = saveAutomation(d.automations ?? [], input, now, ctx.projects.newId)
      d.automations = list
      return { id }
    })
  },

  'automation.delete': (p, ctx) => {
    const id = requireString(p.automationId, 'automationId')
    ctx.projects.apply(p.projectId, (d) => {
      const list = deleteAutomation(d.automations ?? [], id)
      if (list.length > 0) d.automations = list
      else delete d.automations
    })
    return null
  },

  'automation.runNow': (p, ctx) => {
    const id = requireString(p.automationId, 'automationId')
    const { run, error } = scheduler(ctx).run(requireString(p.projectId, 'projectId'), id, 'manual')
    if (error !== undefined) throw error
    return { sessionId: run.sessionId }
  },

  'automation.resolveMissed': (p, ctx) => {
    const s = scheduler(ctx)
    const run = idList(p.run, 'run')
    const dismiss = idList(p.dismiss, 'dismiss')
    const projectId = requireString(p.projectId, 'projectId')
    const cleared = ctx.projects.apply(projectId, (d) => {
      const out = clearMissed(d.automations ?? [], [...run, ...dismiss])
      if (out.cleared.length > 0) d.automations = out.list
      return out.cleared
    })
    const toRun = run.filter((id) => cleared.includes(id))
    return {
      started: toRun.map((automationId) => {
        const { run: r } = s.run(projectId, automationId, 'missed')
        return r.outcome === 'ran' ? { automationId, sessionId: r.sessionId } : { automationId, error: r.error }
      })
    }
  }
}
