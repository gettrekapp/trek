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

/** Starts a run in the automation's run tab (made the first time); answers its session id. A tab still busy skips the run, as the real server does (CONFLICT). */
function runAutomation(ctx: DemoContext, automation: Automation, trigger: AutomationRun['trigger']): string {
  const project = ctx.server.state.project
  let session = runTab(ctx, automation)
  if (session && (session.status === 'working' || session.status === 'attention' || (session.decision && session.status !== 'exited'))) {
    automation.history.unshift({ at: ctx.server.clock.now(), trigger, outcome: 'skipped', error: SKIPPED })
    automation.history.splice(20)
    ctx.server.changed()
    throw new DemoError('CONFLICT', `${automation.name}: ${SKIPPED}`)
  }
  if (!session) {
    session = {
      id: ctx.server.newId('s'),
      title: automation.name,
      llm: automation.llm ?? { provider: 'claude' },
      queue: [],
      status: 'idle',
      context: { kind: 'automation', automationId: automation.id }
    }
    project.globalSessions.push(session)
  }
  if (session.ptyId) ctx.server.terminals.close(session.ptyId)
  session.title = automation.name
  session.ptyId = ctx.server.terminals.open(sessionBanner(agentLabel(session.llm.provider), `Automation · ${automation.name}`), DEMO_ROOT)
  automation.history.unshift({ at: ctx.server.clock.now(), trigger, outcome: 'ran', sessionId: session.id })
  automation.history.splice(20)
  const reply = automation.id === DEMO_NIGHTLY_ID ? NIGHTLY_RUN : replyFor(automation.prompt)
  runPrompt(ctx, { session, list: project.globalSessions }, automation.prompt, reply)
  return session.id
}

export const AUTOMATION_HANDLERS: DemoHandlers<'automation.save' | 'automation.runNow' | 'automation.resolveMissed'> = {
  'automation.save': (ctx, p) => {
    checkProject(p.projectId)
    const input = p.automation
    // The phone edits automations; making one is desktop-only
    if (!input.id) throw notInDemo()
    const automation = findAutomation(ctx.server.state.project.automations, input.id)
    if (!input.name.trim() || !input.prompt.trim()) throw new DemoError('BAD_REQUEST', 'A name and a prompt are needed')
    automation.name = input.name.trim()
    automation.prompt = input.prompt
    automation.schedule = input.schedule
    automation.enabled = input.enabled
    if (input.llm === null) delete automation.llm
    else if (input.llm) automation.llm = input.llm
    const tab = runTab(ctx, automation)
    if (tab) tab.title = automation.name
    ctx.server.changed()
    return { id: automation.id }
  },
  'automation.runNow': (ctx, p) => {
    checkProject(p.projectId)
    const automation = findAutomation(ctx.server.state.project.automations, p.automationId)
    return { sessionId: runAutomation(ctx, automation, 'manual') }
  },
  'automation.resolveMissed': (ctx, p) => {
    checkProject(p.projectId)
    const automations = ctx.server.state.project.automations
    const started: { automationId: string; sessionId?: string; error?: string }[] = []
    for (const id of p.run) {
      const automation = automations.find((a) => a.id === id)
      if (!automation?.missed) {
        started.push({ automationId: id, error: 'Nothing was missed' })
        continue
      }
      delete automation.missed
      try {
        started.push({ automationId: id, sessionId: runAutomation(ctx, automation, 'missed') })
      } catch (err) {
        started.push({ automationId: id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    for (const id of p.dismiss) {
      const automation = automations.find((a) => a.id === id)
      if (automation) delete automation.missed
    }
    ctx.server.changed()
    return { started }
  }
}
