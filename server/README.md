# trek-server

The Trek server: run git worktrees and agent sessions on a machine and connect
to it from the desktop app (and, later, the mobile app). Formerly
`trek-daemon`; the `trek-daemon` command still works for one release and prints a notice.
Wire protocol: see `../PROTOCOL.md`.

Claude sessions **survive disconnects** — close your laptop and the session
keeps running on the server; the app reattaches when it reconnects.

## Requirements

- Linux with Node.js ≥ 20
- **Build tools for node-pty** (it compiles from source): `python3`, `make`,
  `g++` — e.g. `apt install build-essential python3`
- `git` with fetch/push credentials for your repos (the worktree-move flow
  pushes branches through origin)
- `claude` CLI installed and authenticated **as the user the server runs as**

## Install

```sh
git clone <this repo> ~/Trek.Developer
cd ~/Trek.Developer
npm install --omit=dev        # installs node-pty only (compiles from source)
cd server
npm install                   # ws, plus tsx/esbuild for building
npm run build                 # bundles dist/trek-server.cjs
npm link                      # puts `trek-server` on your PATH
```

Upgrading from `trek-daemon`: run `npm link` again in `server/`. On first
start, `~/.config/trek-daemon/config.json` is copied to
`~/.config/trek-server/config.json` (unless that already exists); your token
keeps working as the token named `default`.

If you installed the old systemd unit, replace it:

```sh
systemctl --user disable --now trek-daemon
rm ~/.config/systemd/user/trek-daemon.service
# install trek-server.service as described under Run, then:
systemctl --user daemon-reload && systemctl --user enable --now trek-server
```

Also remove the leftover untracked `daemon/` directory in your checkout
(`rm -rf daemon`; it holds the old `dist/` and `node_modules/`), then run
`npm link` in `server/`.

Rerun `npm run build` after pulling changes. Without linking, run
`./dist/trek-server.cjs` directly, or `npm start` to run from source with tsx.
`trek-server --help` lists every command and option.

## Configure

The server starts with no repos; add them any time. Pre-clone the repo(s) you want to work on, then add each one:

```sh
cd ~/repos/Trek && trek-server .        # the repo you're in (any subdirectory works)
trek-server add ~/repos/Other           # or name a path
trek-server add ~/repos/x --id x --name "Project X"
```

The id defaults to a slug of the directory name and the name to the
directory name. Adding a path that's already configured does nothing. A
running server notices the change and picks it up; no restart needed.

```sh
trek-server list                        # show configured repos
trek-server remove trek                 # remove by id...
trek-server remove ~/repos/Other        # ...or by path (default: current directory)
```

Removing only edits the config; the checkout and its worktrees stay on disk.

This writes `~/.config/trek-server/config.json` (pass `--config` for another
file), which you can also edit by hand:

```json
{
  "repos": [
    { "id": "trek", "name": "Trek", "path": "/home/dev/repos/Trek" }
  ]
}
```

Worktrees are created as siblings of each repo (same convention as the app),
so the repo's parent directory is automatically allowed. Add `worktreeRoots`
for extra locations. The file also holds `serverId` (generated on first start;
clients key their cache by it) and `name` (defaults to the hostname; shown in
clients).

## Agent settings

Which agent CLI each session runs, and how, comes from an optional `llm`
section in the same config file. It has the shape of the desktop's LLM settings:

```json
{
  "llm": {
    "llmDefault": { "provider": "claude" },
    "providers": {
      "claude": { "command": "claude", "approvalMode": "acceptEdits" },
      "local": { "backend": "ollama", "baseUrl": "http://127.0.0.1:11434" }
    }
  }
}
```

The server reloads the file live, so edits apply to the next session you start
or resume. A project's own settings (default LLM, Claude command and permission
mode, system prompts, session types) override it. There is no command or API to
edit this section; edit the file. Agents run as `$SHELL -ilc '<command>'`, so the
command is found the way it is in your terminal; set `SHELL` for the server if it
runs without one.

## Projects

Clients create projects from registered repos (`trek-server add`). Each
project is stored as one JSON file in the data dir:

- Linux: `$XDG_DATA_HOME/trek-server/projects/` (default `~/.local/share/trek-server/projects/`)
- macOS: `~/Library/Application Support/trek-server/projects/`
- Windows: `%LOCALAPPDATA%\trek-server\projects\`

Set `"dataDir"` in the config or pass `--data-dir` to put them elsewhere.
`start --data-dir` remembers the directory in the config, so later commands use it too.
`trek-server remove` refuses to remove a repo that a project still uses.

Create a token for each device that will connect (each prints once; only its
sha256 hash is stored):

```sh
trek-server token add laptop
trek-server token add phone
trek-server token list
trek-server token revoke phone     # closes that device's open connections
```

`trek-server token` on its own creates or rotates the token named `default`.
Paste a token into the app under Settings → Servers.

## Run

```sh
trek-server                   # same as `trek-server start`; ws://127.0.0.1:7345
trek-server --port 7400 --config ./other-config.json
```

For real use, install the systemd user unit (see comments in
`trek-server.service`) so the server — and your Claude sessions — survive
logout and restart on boot.

## Expose it with Caddy (TLS)

The server binds loopback only and refuses public interfaces without TLS.
Put Caddy in front — it handles Let's Encrypt certificates automatically:

```sh
apt install caddy
```

`/etc/caddy/Caddyfile`:

```
dev.example.com {
    reverse_proxy 127.0.0.1:7345
}
```

Then configure the app with `wss://dev.example.com`.

## Security notes

- **The token grants shell access as the server user.** `pty.spawn` starts a
  login shell. Treat the token like an SSH key; run the server as a dedicated
  user if the box is shared.
- The path allowlist (repos + their parent dirs + `worktreeRoots`) protects
  against path typos and confused-deputy bugs, not against a stolen token.
- Auth failures are logged with the peer address; bad tokens get a delayed
  close to blunt brute force.
- Never expose the plain `ws://` listener beyond loopback (`--insecure`
  exists, but don't).

## Smoke test

```sh
npm run smoke                 # against the TypeScript source
npm run smoke -- --built      # against dist/trek-server.cjs (run npm run build first)
```

Starts a throwaway server on loopback with a temp repo, exercises the
handshake, git listing, and a pty spawn/echo/kill round trip.
