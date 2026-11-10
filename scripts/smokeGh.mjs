// scripts/smokeGh.mjs — no smoke runs the real gh (phase 5c-1). Imported first by every smoke that
// starts a trek-server, directly or through the app's Local server: it points TREK_SERVER_GH at a
// stub that answers every call (`auth status`, `api graphql`, anything) "not signed in", so the
// server's sign-in check reaches nothing and its welcome has no prWatch. Children inherit it through
// process.env, and main's childEnv keeps it for the Local server. smoke:server-prwatch sets its own stub for its server instead.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'trek-smoke-gh-'))
const stub = join(dir, 'gh')
writeFileSync(stub, "#!/bin/sh\necho 'You are not logged into any GitHub hosts. (a smoke stub)' >&2\nexit 1\n", { mode: 0o755 })
process.env.TREK_SERVER_GH = stub
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
