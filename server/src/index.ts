// trek-server's entry. `update` and `selfcheck` are commands of their own (they are async, and
// must not load a config or start anything); every other command is main.ts, the server itself
// and its synchronous commands, which parses the same arguments again.
import { parseArgs } from './cli.ts'

const args = parseArgs(process.argv.slice(2))

function die(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

if (args.command === 'selfcheck' || args.command === 'update') {
  // Filled in by the tasks that add these commands.
  die(`trek-server ${args.command} is not available in this build`)
} else {
  void import('./main.ts').catch(die)
}
