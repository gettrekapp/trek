# Project Bot: OS Sandbox (design spike)

## Goal

Run the project bot (a `claude -p` turn spawned by `src/host/bot/turnProcess.ts`) so that the OS
itself stops it from reading or changing Trek's userData directory
(`app.getPath('userData')`, e.g. `~/Library/Application Support/Trek Dev`). The path checks in
`src/host/bot/policy.ts` stay as a second layer.

The shell guard is a deny-list on an allow-by-default shell, so a prompt-injected bot can get
around it with `$( )`, variables, `pushd`, `grep -r ~`, `find -exec cat`, `tar`, `cp -r`,
`python3 -c`, `node -e` or zsh `**`. An OS sandbox does not care how a path is spelled.

This is a spike. The prototypes were throwaway and have been deleted. Only this doc is committed.

**Outcome.** The plan is `docs/superpowers/plans/2026-11-07-bot-os-sandbox.md`. It departs from
this spike in two places, both checked by its prototype:

- **Linux** adds `--unshare-pid --proc /proc`. Without a PID namespace, killing `bwrap` (or a
  SIGTERM to the group) left a background process alive; with one, the kernel ends everything
  when the namespace's first process exits. Trek's process-group kill still works.
- **Tickets became server-side policy.** Trek's MCP server runs the bot's policy on every bot
  `tools/call` itself, and the hook leaves `mcp__trek-dev__*` calls to it. There is no ticket to
  match, so nothing depends on the CLI sending the exact input the hook saw.

A security review then found what the sandbox can't hide on macOS: other processes' argv and
environment. Seatbelt doesn't gate `sysctl(KERN_PROCARGS2)`; `(deny process-info* (target others))`,
`(deny sysctl-read)` and `(deny default)` all leave it readable (`ps -E` itself can't run in the
sandbox, being setuid). So no Trek token is in any process's environment or argv, Codex's included,
and the bot's token is per turn. On Linux the PID namespace hides other processes' `/proc` entries.

**Outcome (final review).** The shipped sandbox hides userData from the bot's own process tree,
and Trek's MCP server enforces the bot's policy on every tool call. A final security review found
that it does not yet stop a determined, prompt-injected bot from getting code run outside the
sandbox: through files that unsandboxed programs run later (git hooks and config, shell rc files,
`~/.claude` settings, the project file, `stack.sh`, LaunchAgents), disk mounts, unsandboxed local
services such as Docker, and delegation. The user accepted this and merges the branch as it is; a
write allow-list and related hardening are the follow-up. The full gap list is in
`docs/superpowers/specs/2026-11-02-project-bot-core-design.md`.

Environment for every prototype: macOS 26.2 (25C56), Apple silicon, Claude Code `2.1.319`
(logged in with claude.ai auth), `--model haiku`. Every prototype used a dummy "secret" directory
under the session scratchpad. In the outputs below `$S` stands for that directory.

## Summary

- **macOS:** wrap the whole `claude` process in `sandbox-exec` with a Trek-generated profile that:
  - allows everything by default;
  - denies `file-read*` and `file-write*` on the real path of userData;
  - denies `file-write-unlink` on each ancestor of userData;
  - denies LaunchServices.

  Do **not** also turn on Claude Code's own sandbox: it cannot start inside an outer seatbelt
  (verified). Add `permissions.deny` `Read`/`Edit` rules for userData to `--settings` as a
  second, model-visible layer.
- **Pass the MCP config inline,** as a JSON string, with `"Authorization": "Bearer ${TREK_BOT_TOKEN}"`.
  The CLI expands `${VAR}` from the environment (verified for both a file and an inline string).
  Then no file in userData has to be readable by the agent, and there is no per-window
  `mcp-bot-<n>.json` at all.
- **Close the token hole on the server.** The bot can always read `TREK_BOT_TOKEN` (`env`), and
  under the outer sandbox it can reach loopback. With that token it can call every Trek MCP tool
  directly with `curl`, skipping the policy hook. This was verified against a mock server, and it
  is true today, sandbox or not. Fix: `/mcp` `tools/call` from a bot client must match a one-shot
  ticket that `/bot/policy` issued when it allowed that exact call.
- **Linux:** the same shape with `bwrap` around the whole process: bind `/`, put a `tmpfs` over
  userData, `--die-with-parent`. This was not verified (no Linux host). Claude Code's own
  bubblewrap sandbox is the fallback option.
- **Windows:** no OS sandbox is available (Claude Code's own sandbox runs commands unsandboxed on
  native Windows). The bot is already POSIX-only in practice (it kills process groups, and Trek
  ships only a mac arm64 build). Make Windows explicitly unsupported.
- **Failure mode:** refuse to run the turn. Don't fall back to the path checks alone.

## Findings

### 1. Claude Code's own sandbox

Docs: <https://code.claude.com/docs/en/sandboxing> (old URL `docs.claude.com/en/docs/claude-code/sandboxing`
301-redirects there), <https://code.claude.com/docs/en/permissions>, <https://code.claude.com/docs/en/settings>.

**What it enforces.** OS-level filesystem and network limits on shell commands only: "It applies
to Bash, PowerShell, and Monitor tool commands and their child processes." It uses Seatbelt on
macOS and bubblewrap on Linux and WSL2.

By default:

- writes are limited to the working directory, a per-user temp directory and added directories;
- reads cover "most of the machine";
- the network has "no direct route out": TCP goes through a local proxy with a domain allowlist
  that starts empty.

**It does not cover Read, Grep or Glob.** From the sandboxing page:

> The sandbox covers shell commands only. Claude's file tools, MCP servers, and hooks run outside
> it. [...] A `denyRead` entry doesn't stop the Read tool.

Those tools are governed by permission rules instead. The permissions page says Claude "makes a
best-effort attempt to apply `Read(path)` deny rules to all built-in tools that read files like
Grep and Glob". It also says a `Read` deny blocks Edit and Write on the same path, but not
NotebookEdit. (In 2.1.319 the `-p` tool list has no Grep or Glob tool at all. A Grep call
returned "No such tool available".)

**Merging (verified).** "Paths and domains from both sandbox settings and permission rules are
merged into the final sandbox configuration." With no `sandbox.filesystem` key at all,
`permissions.deny: ["Read(//$S/secret/**)", "Edit(//$S/secret/**)"]` blocked sandboxed `python3`
from both reading and writing the directory:

```
USE Bash python3 -I -c "print(open('$S/secret/token.json').read())"
  RES ERR PermissionError: [Errno 1] Operation not permitted
USE Bash python3 -I -c "open('$S/secret/new2.txt','w').write('x')"; ls $S/secret
  RES ERR PermissionError: [Errno 1] Operation not permitted
```

Watch out: `sandbox.filesystem.denyRead` alone does **not** stop writes. In the first run,
`echo hi > $S/secret/new.txt` succeeded because `$S` sits in the per-user temp directory, which
is writable by default. Always pair `Read` with `Edit` (or with `denyWrite`).

**Path syntax.** In permission rules, `//abs/path` is absolute and `/path` is relative to the
settings source. Sandbox `filesystem` paths use plain `/abs` and `~/`. For deny rules, symlinks
are checked on both the requested path and the resolved path.

**Enabling it for `claude -p`.** Pass `--settings '<json>'` (Trek already passes the hook this way).
The CLI help says `--settings <file-or-json>`. The sandboxing page shows
`claude --settings '{"sandbox": {"enabled": true, "allowUnsandboxedCommands": false}}'`. Verified
working in `-p` mode.

**Turning it off from inside.** The model can set `dangerouslyDisableSandbox: true`. Setting
`sandbox.allowUnsandboxedCommands: false` makes the CLI ignore the parameter ("With the retry
disabled, Claude Code ignores the `dangerouslyDisableSandbox` parameter"). Verified: with the
PreToolUse hook returning `allow` for everything:

```
USE Bash {"command": "cat $S/secret/token.json", "dangerouslyDisableSandbox": true}
  RES ERR cat: $S/secret/token.json: Operation not permitted
```

Two other ways out need closing:

- `sandbox.excludedCommands`: "An excluded command runs with your full access." The bot loads
  the user's `~/.claude/settings.json`, and arrays merge across settings sources, so a user's
  `excludedCommands` would apply to the bot.
- `sandbox.failIfUnavailable`: without it, "when the platform doesn't support the sandbox or the
  dependency check at startup fails, Claude Code runs commands without sandboxing."

**Platforms.** macOS (Seatbelt), Linux and WSL2 (bubblewrap, plus socat for the proxy). Native
Windows: "Claude Code runs commands unsandboxed."

**Prototype 1: Claude Code's sandbox alone.**

Settings:

```json
{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,
            "filesystem":{"denyRead":["$S/secret"]}},
 "permissions":{"deny":["Read(//$S/secret/**)"]},
 "hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"echo '<allow JSON>'"}]}]}}
```

The hook allows everything, which is the worst case for Trek's policy. The cwd held `link.json`,
a symlink to the secret. Every attempt was blocked:

```
USE Bash cat $S/secret/token.json                     -> Operation not permitted
USE Bash cat $(echo $S/secret/token.json)             -> Operation not permitted
USE Bash python3 -I -c "print(open(...).read())"      -> PermissionError [Errno 1]
USE Bash node -e "...readFileSync(...)"               -> EPERM
USE Bash cat link.json   (symlink to the secret)      -> Operation not permitted
USE Bash grep -r TOPSECRET $S/secret $S/work/link.json -> cannot open directory: Operation not permitted
USE Bash curl -s -m 3 http://127.0.0.1:47811/         -> exit 7 (loopback blocked)
USE Bash cat ... with dangerouslyDisableSandbox: true -> Operation not permitted
USE Read $S/secret/token.json   -> "File is in a directory that is denied by your permission settings."
USE Read $S/work/link.json      -> "Permission to read ... has been denied."
```

That run cost $0.01. Note the loopback result: sandboxed Bash cannot reach Trek's MCP port by
default (on macOS, `network.allowLocalBinding: true` lifts that). This matters for question 4.

**Prototype 2: malformed `--settings`.** Passing `"denyRead": "<string>"` instead of an array made
the CLI **silently drop the whole `--settings` value**: no sandbox, no deny rules and no
PreToolUse hook. The stream showed only the user's own plugin `SessionStart` hooks, and Bash got
"This command requires approval". The CLI help says the same: "Settings files that fail validation
are silently ignored in this mode." Nothing in the stream-json `init` message reports sandbox
state, so Trek cannot detect this from the output. Here it failed closed only because `-p` without
the hook denies prompts. A future CLI that rejects one of Trek's keys would quietly remove both
the sandbox and the policy hook.

### 2. macOS `sandbox-exec` around the whole `claude` process

`/usr/bin/sandbox-exec` exists on macOS 26.2 and works. It is deprecated, but Apple's own
tooling and Claude Code still use the same Seatbelt profiles.

**Prototype 3: plain processes.** Profile `(version 1)(allow default)(deny file-read* file-write* (subpath "$S/secret"))`:

| Attempt | Result |
| :- | :- |
| `/bin/sh -c 'cat $S/secret/token.json'` | `Operation not permitted` |
| `cat $(echo …)` | `Operation not permitted` |
| `cat link.json` (symlink into the secret) | `Operation not permitted` |
| `cat hard.json` (hard link made **before** the sandbox) | **`TOPSECRET-123` (leak)** |
| `ln $S/secret/token.json hard2.json` (made inside) | `Operation not permitted` |
| `ls $S/secret`, `grep -r`, zsh `**` glob | `Operation not permitted` / no matches |
| `node -e readFileSync`, `python3 -I -c open()` | EPERM |
| `tar cf - secret`, `cp -r secret copy` | `Operation not permitted` |
| `echo x > $S/secret/new.json`, `mv $S/secret …` | `Operation not permitted` |
| case variant `/PRIVATE/TMP/…/SECRET/token.json` | `Operation not permitted` |
| `cd $S && cat ./secret/../secret/token.json` | `Operation not permitted` |

What this shows:

- **Symlinks:** Seatbelt checks the resolved path, so a symlink is denied.
- **Hard links:** a hard link that already exists under another path is **not** denied, because
  the profile matches paths, not inodes. The bot cannot make a new one. Trek never makes hard
  links to these files, so the only exposure is links someone else made.
- **Paths must be real paths.** With the profile parameter set to the `/tmp/...` spelling of a
  `/private/tmp/...` directory, the file was readable through both spellings. The profile fails
  **open** on a non-canonical path, so Trek must `realpathSync` userData before building it.
  (`~/Library/Application Support` is normally not a symlink, but don't rely on that.)

**Ancestor rename leak (found and fixed).** With only the subpath rule,
`mv $S/anc $S/anc2 && cat $S/anc2/secret/t.json` printed the secret: renaming an **ancestor**
moves the files out from under the rule. Adding `(deny file-write-unlink (literal "$S/anc"))`
blocked the rename (`file-write-create` did not). Creating and deleting files inside that ancestor
still worked. So the profile denies `file-write-unlink` on the literal path of every ancestor of
userData, up to `/`. Claude Code's own sandbox avoids this because its write allowlist leaves out
userData's ancestors.

**LaunchServices escape (found and fixed).** Under `(allow default)`, `/usr/bin/open ./Esc.app`
launched a bot-written background `.app` **outside** the sandbox, and it printed the secret:

```
sandbox-exec -f p.sb /usr/bin/open $S/work/Esc.app; cat escaped.txt   -> TOPSECRET-123
```

What does and doesn't block it:

- `(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") …)` did **not**
  block it.
- `(deny mach-lookup (global-name-regex #"^com\.apple\.(lsd|coreservices|launchservices)"))`
  **did**: `open` failed with `kLSNoExecutableErr`, and `git`, `node` and `claude` still worked.
- Claude Code's own sandbox also blocks `open` (`kLSUnknownErr`).
- `launchctl submit` from inside the sandbox did not run its job (it ran fine outside), so launchd
  did not look like an escape.

**Apple Events: not closed.** `osascript -e 'tell application "System Events" to get name'`
worked under the outer profile, even with `(deny appleevent-send)` and several `mach-lookup`
denials. It also worked under Claude Code's own sandbox. So a bot could try
`tell application "Terminal" to do script "…"`, which runs outside any sandbox. I didn't run that,
because it opens Terminal. macOS TCC asks the user the first time an app (here, Trek as the
responsible process) controls Terminal, so this path needs a visible user click. It is listed
under Risks.

**Prototype 4: `claude` under the outer profile.** Claude Code's sandbox was off, and the hook did
a real `curl` to a loopback server before allowing. Everything worked:

- claude.ai auth from the keychain, the API, `~/.claude` writes, the hook's loopback curl;
- `git --version`, and `curl` to loopback from Bash;
- the dummy MCP server connected with `status: connected`;
- the OS denied the Read tool too: `EPERM: operation not permitted, open '$S/secret/token.json'`.

That last point is the key advantage over Claude Code's own sandbox. The outer profile covers
the whole process tree: the Read, Edit and Write tools, hooks, the user's plugin hooks, MCP stdio
servers and Bash.

**Prototype 5: nesting.** Running `claude` with Claude Code's sandbox on, under the outer
`sandbox-exec`, made every Bash call fail:

```
RES ERR Exit code 71 | sandbox-exec: sandbox_apply: Operation not permitted
```

A trivial `sandbox-exec … sandbox-exec … sh -c 'echo nested ok'` does work. Claude Code's
generated profile is what can't be applied inside an outer one. This fails closed (nothing runs),
but it means **pick one: the outer profile or Claude Code's sandbox, not both**.

**Prototype 6: the final profile end to end.** This was the proposed profile below, with a fake
userData at `$S/ud/Trek Dev` (the space was deliberate), passed in with `-D` parameters. The run
also used `--settings` with `Read`/`Edit` deny rules plus a hook that curls loopback and then
allows, and an inline `--mcp-config` using `${TREK_SPIKE_TOKEN}`:

```
USE Bash python3 -I -c "glob.glob('$S/ud/*/*.json') ..."  -> []   (listing denied)
USE Bash mv $S/ud $S/ud2 && cat ...                         -> mv: Operation not permitted
USE Bash /usr/bin/open ./Esc.app; cat escaped.txt           -> kLSNoExecutableErr, no file
USE Bash env | grep -c TREK_SPIKE_TOKEN; curl ... /mcp tools/list
                                                            -> 1 | {"result": {"tools": []}}   <- token usable
USE Read "$S/ud/Trek Dev/server-tokens.json"                -> denied by permission settings (layer 2)
USE Bash cat "$S/ud/Trek Dev/server-tokens.json"            -> denied by permission settings (layer 2)
```

In an earlier run without the layer-2 rules, the OS layer itself denied Read and `cat`
(prototype 4).

### 3. Linux and Windows

What Trek supports today:

- `package.json` `build` defines only a `mac` target (dmg, arm64).
- `turnProcess.ts` spawns `detached` and kills with `process.kill(-pid)`. That is a POSIX process
  group, and it doesn't work on Windows.
- `policy.ts` folds case on darwin and win32, but nothing else is Windows-aware.

So the bot is effectively macOS (and maybe Linux from source) today.

**Linux (docs only, not verified).** There are two options:

- **(a) `bwrap` around the whole process,** the same shape as macOS:
  `bwrap --dev-bind / / --tmpfs <realpath(userData)> --die-with-parent -- claude …`. The tmpfs
  hides the directory from every process in the mount namespace, Read tool included. Renaming an
  ancestor doesn't help the bot: the mount sits over the path in the bot's own namespace, and the
  real files are never visible there. A pre-existing hard link elsewhere still leaks, as on macOS.
  Don't use `--unshare-pid` or `--new-session`, so that Trek's process-group kill keeps working.
  Nesting Claude Code's bubblewrap sandbox inside it is untested. The docs mention
  `enableWeakerNestedSandbox` for containers and warn that it weakens isolation, so plan on keeping
  Claude Code's sandbox off, as on macOS.
- **(b) Claude Code's own sandbox** (bubblewrap + socat). It brings the same caveats as macOS:
  only Bash is covered, Read relies on best-effort permission rules, settings can be silently
  ignored, and user settings merge in.

Recommend (a), with (b) as a fallback only if bwrap can't be used.

**Windows.** Claude Code's sandbox doesn't run on native Windows ("runs commands unsandboxed"; use
WSL2). There is no supported, non-admin, whole-process filesystem deny on Windows that Trek could
apply simply. AppContainer or a restricted token would block far more than userData and needs
native code. Recommend: the bot refuses to start on `win32` with a clear message. A WSL2-hosted
`claude` could get option (b) later.

### 4. The MCP config and token

**How it's passed today.** `botMcpAccess` (`src/main/mcp.ts`) writes
`userData/mcp-bot-<windowId>.json` (mode 0600) with `headers.Authorization: Bearer <token>`, and
`claudeArgs` passes its path to `--mcp-config`. The `claude` process itself reads that file at
startup. Under an outer sandbox that denies userData, the CLI could not read it.

**Nothing else in userData is needed by the agent.**

- `--settings` is an inline JSON string.
- The bot folder (`<project>.trekbot`) sits next to the project file.
- Repos come in through `--add-dir`.
- Consent, the lock and the secret stores are read by Trek's main process, not the agent.

**Fix (verified).** Claude Code expands `${VAR}` in MCP `url` and `headers`
(<https://code.claude.com/docs/en/mcp>, "Environment variable expansion"). The page only names
`.mcp.json`, so I tested `--mcp-config` both ways. A tiny HTTP server logged:

```
TREK_SPIKE_TOKEN=expanded-abc claude -p "reply ok" --mcp-config $S/work/mcp.json --strict-mcp-config
  -> AUTH=Bearer expanded-abc  (server/discover, initialize, notifications/initialized, tools/list)
TREK_SPIKE_TOKEN=inline-xyz claude -p "reply ok" --strict-mcp-config \
  --mcp-config '{"mcpServers":{"spike":{"type":"http","url":"http://127.0.0.1:47812/mcp",
                 "headers":{"Authorization":"Bearer ${TREK_SPIKE_TOKEN}"}}}}'
  -> AUTH=Bearer inline-xyz
```

So pass `--mcp-config '{"mcpServers":{"trek-dev":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer ${TREK_BOT_TOKEN}"}}}}'`.
There is no file, and no secret in argv: `ps` shows the literal `${TREK_BOT_TOKEN}`. The only
copy of the token is the environment variable, which already exists for the hook. The docs warn
that a few well-known names (e.g. `ANTHROPIC_API_KEY`) are read as empty in remote headers.
`TREK_BOT_TOKEN` isn't one of them.

**`TREK_BOT_TOKEN` in env is a real concern, but not a secrets-file one.** The bot can run `env`.
Under any whole-process sandbox, anything the CLI can use (env, argv, files it reads) is
reachable from Bash too, so the token has to be treated as known to the bot.

Is it scoped to the bot's permissions? **No.** The token authenticates the bot's MCP client in
`handleRequest`. It allows `/bot/policy` and every MCP tool in `TOOLS` plus `request_approval`,
and **it does not run the policy**. The policy runs only in the CLI's PreToolUse hook. Prototype 6
showed Bash calling `tools/list` on loopback with the env token.

So a prompt-injected bot can `curl` `close_session`, `send_keys` or `promote_to_primary` (all
"ask" tools in `policy.ts`) without approval. Worse, `send_keys`/`send_prompt` into an unsandboxed
worktree agent is a confused-deputy route to the secret files that no OS sandbox around the bot
can stop. This exists today, independent of this spike.

- Claude Code's own sandbox happens to block it: loopback was blocked, curl exit 7.
- The outer `sandbox-exec` does not, because the hook needs loopback and the profile can't tell
  the CLI from its children.

Fix on the server:

- When `/bot/policy` returns `allow` for an `mcp__trek-dev__<name>` call, Trek records a one-shot
  ticket keyed by `name` + a stable serialisation of the input (`callKey`'s `stable`), valid for a
  short window (e.g. 60 s).
- `/mcp` `tools/call` from a bot client must consume a matching ticket, or get an `isError`
  result: "Calls to Trek's tools must go through the bot's tool policy."
- A bot that POSTs a forged hook payload to `/bot/policy` itself only gets tickets for calls its
  policy allows. That is the same outcome as calling the tool normally, and approvals are spent
  the same way.
- `initialize`, `tools/list` and `ping` need no ticket.

The `send_prompt` confused-deputy problem is about policy, not the sandbox. See the open
questions.

### 5. Failure mode

Recommend **refusing to run the turn**. Show it as an error view ("The bot needs macOS's sandbox,
which isn't available: <reason>") rather than falling back to the path checks behind a warning:

- The path checks are known to be bypassable by a prompt-injected bot. A warning the user
  dismisses once protects nothing on every later heartbeat, and the bot runs unattended.
- On macOS the dependency is `/usr/bin/sandbox-exec`, which ships with the OS. It only fails if
  Apple removes it, or if the profile no longer compiles on a new OS. Both should be loud.
- Trek can test cheaply and deterministically at bot start, before any turn: run
  `sandbox-exec -D … -f <profile> /bin/sh -c 'cat <userData>/bot-consent.json'` and expect exit 1
  with `Operation not permitted`, then run `/usr/bin/true` and expect exit 0. If the canary can
  read the file, or the profile fails to compile, the bot does not start.

## Recommended design

### Common (all platforms)

1. **No MCP config file for the bot.** `botMcpAccess` stops writing `mcp-bot-<n>.json` and
   returns `{ url, token, port }`. `TurnOptions.mcpConfig` becomes the inline JSON string with
   `${TREK_BOT_TOKEN}`. `releaseMcpWindow` no longer has a bot file to remove. `removeStaleConfigs`
   keeps its regex for files from older versions. `BOT_SECRET_FILES` keeps `mcp-*.json`, because
   worktree and Gemini configs still live there.
2. **Server-side policy tickets** on `/mcp` `tools/call` for bot clients, as described above.
3. **Layer-2 permission rules** in `hookSettings`:
   `permissions.deny: ["Read(//<realpath(userData)>/**)", "Edit(//<realpath(userData)>/**)"]`.
   On macOS also add the `app.getPath('userData')` spelling if it differs. These give the model a
   clear denial, and Claude Code applies them to `cat`/`<`/`>` too. Keep `policy.ts` unchanged.
4. **Platform gate** in `startBot`: build the sandbox wrapper for the platform, run the canary,
   and refuse with an error view on failure. Refuse if the bot folder, the cwd or any `--add-dir`
   lies inside userData (it would be unreadable, and it's a misconfiguration).

### macOS

`turnProcess.ts` gets an optional `sandbox?: { command: string[] }` prefix, or `bot.ts` builds the
whole argv. `spawn(sandboxExec, [...sandboxArgs, bin, ...prefix, ...claudeArgs])`, where
`sandboxArgs = ['-D', 'USERDATA=<real>', '-D', 'ANC0=<…>', …, '-f', '<profile path>']`.

- The profile is static text shipped in `resources/` (or written from a constant) and takes
  parameters, so no path ever needs SBPL string escaping. Trek generates the
  `(literal (param "ANCn"))` list to match the ancestor count, or pads with `/` as the prototype
  did.
- Spawning `sandbox-exec` as the group leader keeps `detached` and the group kill working:
  `sandbox-exec` is expected to exec into `claude` (not verified; task 5 checks it).
- `ENOENT` on `sandbox-exec` maps to a new `TurnOutcomeKind` of `'sandbox'`, not `'missing'`.
- The user's `claudeCommand` still runs, inside the sandbox.

Proposed profile:

```scheme
(version 1)
(allow default)
; Trek's userData: nothing in the bot's process tree may read or change it.
(deny file-read* file-write* (subpath (param "USERDATA")))
; Renaming an ancestor would move userData out from under the rule above.
(deny file-write-unlink (literal (param "ANC0")) (literal (param "ANC1")) ...)
; LaunchServices would start an app (one the bot wrote) outside this sandbox.
(deny mach-lookup (global-name-regex #"^com\.apple\.(lsd|coreservices|launchservices)"))
```

What it allows, all needed and verified working:

- `~/.claude` (auth config, sessions, transcripts) and the keychain (claude.ai OAuth);
- the bot folder, the worktrees and the temp dir;
- the network: the Anthropic API, git remotes, and loopback for the hook and MCP;
- the user's ssh-agent socket.

Claude Code's own sandbox stays **off**, because it can't nest. `hookSettings` should set
`sandbox.enabled: false` explicitly, so a user's `~/.claude/settings.json` that turns it on doesn't
break every Bash call with `sandbox_apply` errors.

### Linux

The same wiring with `bwrap`: `--dev-bind / / --tmpfs <real userData> --die-with-parent --`. If
`bwrap` is missing, or the canary fails (some distros restrict unprivileged user namespaces), the
bot refuses. The fallback with Claude Code's own sandbox (`sandbox.enabled`, `failIfUnavailable`,
`allowUnsandboxedCommands: false`, the deny rules above) is a possible later option. It is weaker
because only Bash is covered and settings can be silently ignored.

### Windows

The bot refuses to start on `win32`: "The project bot needs an OS sandbox, which Windows doesn't
provide." Note that it isn't supported there.

## Risks

- **`sandbox-exec` is deprecated.** It works on macOS 26.2 and Claude Code itself depends on
  Seatbelt, but Apple could remove it. The canary turns that into a visible refusal, not a silent
  hole.
- **The profile fails open on a wrong path.** A non-canonical path silently protects nothing
  (verified with `/tmp` vs `/private/tmp`). Always `realpathSync`, and let the canary prove it.
- **Pre-existing hard links** to a secret file elsewhere are readable (verified). Trek doesn't make
  them. Backups and snapshots are similar: Time Machine local snapshots, or a backup disk mounted
  under `/Volumes`, hold copies under other paths. Secret stores are `safeStorage`-encrypted (the
  key is in the keychain under Trek's ACL), so those copies are ciphertext. Plaintext files such
  as `environments.json` and the short-lived `mcp-*.json` would be exposed through a backup path.
- **Apple Events** (e.g. `osascript` driving Terminal) can run code outside the sandbox. The
  outer profile doesn't block them (verified that AE delivery works). TCC Automation consent is
  the only gate. A follow-up could look for an SBPL rule that blocks AE without breaking `claude`.
- **The confused deputy through Trek's own tools.** `send_prompt`, `send_keys` and `start_session`
  into worktree agents run outside the bot's sandbox. The ticket fix stops the *direct* curl
  bypass, but an allowed `send_prompt` can still ask an unsandboxed worktree session to read
  userData. That's a policy decision (see open questions).
- **User settings and plugins load into the bot.** The prototype runs showed the user's plugin
  `SessionStart` hooks running. Under the outer profile they are contained, so they are no longer
  a secrets risk. They still cost time and add context.
- **Network is not restricted** by the outer profile. The goal here is only to keep the secret
  files unreadable. Exfiltrating repo contents is out of scope.
- **Silent `--settings` drop** (verified). Under the outer sandbox this no longer opens the
  secrets, but it would drop the policy hook. Worth a separate check: e.g. have the hook record
  that it ran, and treat a turn whose tool calls never hit `/bot/policy` as a crash.

## Proposed tasks

1. **Inline MCP config.** `botMcpAccess` returns `{ url, port, token }` and writes no file.
   `claudeArgs` passes the inline JSON with `${TREK_BOT_TOKEN}`. Update `mcp.ts` release and stale
   cleanup, and any tests or `bot-smoke` checks that expect the file.
2. **Policy tickets on `/mcp`.** `/bot/policy` `allow` for an `mcp__trek-dev__*` call mints a
   one-shot, short-lived ticket. Bot-client `tools/call` must consume one. Add unit tests for a
   match, a mismatch, expiry and a forged direct call.
3. **macOS sandbox wrapper (pure).** A function from `(userDataReal, platform)` to
   `{ command, args }` or a refusal reason, plus the profile resource with parameterised
   ancestors. Unit-test the argv for paths with spaces and quotes, and the ancestor list.
4. **Canary and platform gate.** At bot start: realpath userData, run the canary
   (denied read, then `/usr/bin/true`), refuse on failure, refuse on `win32`, and refuse when the
   folder or a repo is inside userData. Add a new error view and a `sandbox` outcome kind in
   `turnProcess.ts`.
5. **Wire it into `turnProcess.ts` and `bot.ts`.** Prefix the spawn with the wrapper, and keep
   `detached` and the group kill (check that SIGTERM reaches `claude` through `sandbox-exec`'s
   exec). Add `sandbox.enabled: false` and the `Read`/`Edit` deny rules to `hookSettings`.
6. **Smoke test.** Extend `scripts/bot-smoke.mjs`, or add a script, to run a real turn under the
   wrapper that tries `cat`, `python3 -c` and the Read tool on a userData file, plus an ancestor
   `mv` and `open` of a written `.app`. Expect all to fail, while a worktree `git status` succeeds.
7. **Linux bwrap wrapper** behind the same interface, with its canary. It needs a Linux machine to
   verify (tmpfs overmount, process-group kill, `--die-with-parent`).
8. **Docs.** Update the bot design spec and the `botSecretFiles.ts` header to say the OS sandbox
   is the primary layer and the path checks are the second one.

## Open questions

1. **Refuse vs warn.** This doc recommends refusing when the sandbox can't be applied. Do you want
   an explicit, per-project "run without the OS sandbox" override for development, or none at all?
2. **Linux.** Is Linux a target for the bot at all? If not, the bot could refuse on everything
   except macOS for now and skip task 7.
3. **Delegation as a confused deputy.** `send_prompt`/`start_session`/`send_keys` let the bot drive
   unsandboxed worktree agents. Should those move from free to "ask" while the bot is unattended,
   or should worktree sessions that a bot starts also run under the same profile?
4. **Network.** Should the bot's network be limited too (e.g. Claude Code's sandbox proxy
   allowlist, or a profile that allows only loopback and the API)? That is out of scope for "can't
   read secrets", but it is the other half of exfiltration.
5. **Apple Events.** Is the TCC prompt an acceptable gate, or should a follow-up spike find an
   SBPL rule that blocks AE under `(allow default)`?
