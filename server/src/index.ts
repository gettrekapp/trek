// trek-server's entry. `update` and `selfcheck` are commands of their own (they are async, and
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
  // Filled in by the task that adds the command.
  die('trek-server update is not available in this build')
} else {
  // An error thrown while main.ts loads is a bug, not a message for the user: keep its stack, as before the split.
  void import('./main.ts').catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
