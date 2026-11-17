// The demo's automations (apps/mobile/src/demo): edits, run now, and missed runs. A run renews the
// automation's run tab (one Global session) and plays its script there.
import type { Automation, AutomationRun, Session } from '../../shared.ts'
import { DEMO_NIGHTLY_ID, DEMO_ROOT } from '../demoData.ts'
import { DemoError, notInDemo } from '../demoError.ts'
import type { DemoHandlers } from '../demoHandlers.ts'
import { checkProject, findAutomation } from '../demoProject.ts'
import { NIGHTLY_RUN, replyFor, sessionBanner } from '../demoScripts.ts'
import type { DemoContext } from '../demoServer.ts'
import { agentLabel, runPrompt } from './sessions.ts'

function runTab(ctx: DemoContext, automation: Automation): Session | undefined {
  return ctx.server.state.project.globalSessions.find((s) => s.context?.kind === 'automation' && s.context.automationId === automation.id)
}

const SKIPPED = 'previous run still working'

/** The result of starting a run, like the real scheduler's: the run tab's session id, or why it was skipped */
type RunResult = { sessionId: string } | { error: string }

/** Starts a run in the automation's run tab (made the first time). A tab still busy skips the run. */
function runAutomation(ctx: DemoContext, automation: Automation, trigger: AutomationRun['trigger']): RunResult {
  const project = ctx.server.state.project
  const at = ctx.server.clock.now()
  let session = runTab(ctx, automation)
  if (session && (session.status === 'working' || session.status === 'attention' || (session.decision && session.status !== 'exited'))) {
    automation.history.unshift({ at, trigger, outcome: 'skipped', error: SKIPPED })
    automation.history.splice(20)
    ctx.server.changed()
    return { error: SKIPPED }
  }
  if (!session) {
    session = { id: ctx.server.newId('s'), title: automation.name, llm: automation.llm ?? { provider: 'claude' }, queue: [], status: 'idle', context: { kind: 'automation', automationId: automation.id } }
    project.globalSessions.push(session)
  }
  if (session.ptyId) ctx.server.terminals.close(session.ptyId)
  // A renewed tab: its queue is emptied and its agent is the automation's current one
  session.title = automation.name
  session.queue = []
  session.llm = automation.llm ?? { provider: 'claude' }
  session.ptyId = ctx.server.terminals.open(sessionBanner(agentLabel(session.llm.provider), `Automation · ${automation.name}`), DEMO_ROOT)
  automation.history.unshift({ at, trigger, outcome: 'ran', sessionId: session.id })
  automation.history.splice(20)
  const reply = automation.id === DEMO_NIGHTLY_ID ? NIGHTLY_RUN : replyFor(automation.prompt)
  runPrompt(ctx, { session, list: project.globalSessions }, automation.prompt, reply)
  return { sessionId: session.id }
}

export const AUTOMATION_HANDLERS: DemoHandlers<'automation.save' | 'automation.runNow' | 'automation.resolveMissed'> = {
  'automation.save': (ctx, p) => {
    checkProject(p.projectId)
    const input = p.automation
    // The phone edits automations; making one is desktop-only
    if (!input.id) throw notInDemo()
    const automation = findAutomation(ctx.server.state.project.automations, input.id)
    if (!input.name.trim() || !input.prompt.trim()) throw new DemoError('BAD_REQUEST', 'A name and a prompt are needed')
    // A schedule change or a re-enable restarts the clock: nothing counts as missed; off, nothing is missed (automations/model.ts)
    const restart = automation.schedule.cron !== input.schedule.cron || automation.schedule.tz !== input.schedule.tz || (!automation.enabled && input.enabled)
    automation.name = input.name.trim()
    automation.prompt = input.prompt
    automation.schedule = input.schedule
    automation.enabled = input.enabled
    if (restart) {
      automation.lastSlot = ctx.server.clock.now()
      delete automation.missed
    }
    if (!input.enabled) delete automation.missed
    if (input.llm === null) delete automation.llm
    else if (input.llm) automation.llm = input.llm
    ctx.server.changed()
    return { id: automation.id }
  },
  'automation.runNow': (ctx, p) => {
    checkProject(p.projectId)
    const automation = findAutomation(ctx.server.state.project.automations, p.automationId)
    const run = runAutomation(ctx, automation, 'manual')
    if ('error' in run) throw new DemoError('CONFLICT', `${automation.name}: ${run.error}`)
    return { sessionId: run.sessionId }
  },
  'automation.resolveMissed': (ctx, p) => {
    checkProject(p.projectId)
    const automations = ctx.server.state.project.automations
    const started: { automationId: string; sessionId?: string; error?: string }[] = []
    const run = [...new Set(p.run)].filter((id) => automations.some((a) => a.id === id && a.missed))
    // Cleared first, as the real server does, so a run that is skipped doesn't leave its missed slot behind
    for (const id of [...run, ...p.dismiss]) {
      const automation = automations.find((a) => a.id === id)
      if (automation) delete automation.missed
    }
    for (const id of run) {
      const result = runAutomation(ctx, findAutomation(automations, id), 'missed')
      started.push('error' in result ? { automationId: id, error: result.error } : { automationId: id, sessionId: result.sessionId })
    }
    ctx.server.changed()
    return { started }
  }
}
