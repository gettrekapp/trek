// The update.* protocol methods (the `update` capability): a client reads a server's update
// state, has it look for a newer release, and has it install one. Any signed-in connection may
// ask, as for `pairing.create`: a token already holds shell-level power on this machine, what
// gets installed is fixed whoever asks (a newer release signed with the project's key), and
// `updates.remoteApply: false` in the config leaves installing to the command on the machine.
import { codedError } from '../errors.ts'
import type { V2Context } from '../v2.ts'

type Handler = (params: any, ctx: V2Context) => unknown

function service(ctx: V2Context): NonNullable<V2Context['update']> {
  if (!ctx.update) throw codedError('NOT_FOUND', 'This server does not update itself (it is the local server, or it was not installed from a release tarball)')
  return ctx.update
}

export const updateHandlers: Record<string, Handler> = {
  'update.status': (_p, ctx) => service(ctx).status(),
  // Awaited: answered once the feed has been read.
  'update.check': (_p, ctx) => service(ctx).check(),
  // The service checks the version it is given, and answers at once: the update goes on after it.
  'update.apply': (p, ctx) => service(ctx).apply(p?.version)
}
