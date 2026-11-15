// trek-server's entry. `update`, `selfcheck` and `plugin` are commands of their own (they are async, and
// must not load a config or start anything); every other command is main.ts, the server itself
// and its synchronous commands, which parses the same arguments again.
import { parseArgs } from './cli.ts'

const args = parseArgs(process.argv.slice(2))

function die(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

if (args.command === 'selfcheck') {
  void import('./update/selfcheck.ts').then((m) => m.runSelfcheckCommand()).then((code) => process.exit(code), die)
} else if (args.command === 'update') {
  // The bundle's own folder (the install). A source run (tsx) has server/src here, or no __dirname
  // at all as an ES module: neither is an install, and the command says so.
  const installDir = typeof __dirname === 'string' ? __dirname : ''
  void import('./update/command.ts').then((m) => m.runUpdateCommand(args, installDir)).then((code) => process.exit(code), die)
} else if (args.command === 'plugin') {
  void import('./plugins/command.ts').then((m) => m.runPluginCommand(args)).then((code) => process.exit(code), die)
} else {
  // An error thrown while main.ts loads is a bug, not a message for the user: keep its stack, as before the split.
  void import('./main.ts').catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
