# trek-daemon

Companion daemon for Trek Dev: run git worktrees and Claude Code sessions
on a remote Linux server and connect to them from the desktop app (and, later,
the mobile app). Wire protocol: see `../PROTOCOL.md`.

Claude sessions **survive disconnects** — close your laptop and the session
keeps running on the server; the app reattaches when it reconnects.

## Requirements

- Linux with Node.js ≥ 20
- **Build tools for node-pty** (it compiles from source): `python3`, `make`,
  `g++` — e.g. `apt install build-essential python3`
- `git` with fetch/push credentials for your repos (the worktree-move flow
  pushes branches through origin)
- `claude` CLI installed and authenticated **as the user the daemon runs as**

## Install

```sh
git clone <this repo> ~/Trek.Developer
cd ~/Trek.Developer
npm install --omit=dev        # installs node-pty only (compiles from source)
cd daemon
npm install                   # ws, plus tsx/esbuild for building
npm run build                 # bundles dist/trek-daemon.cjs
npm link                      # puts `trek-daemon` on your PATH
```

Rerun `npm run build` after pulling changes. Without linking, run
`./dist/trek-daemon.cjs` directly, or `npm start` to run from source with tsx.
`trek-daemon --help` lists every command and option.

## Configure

Pre-clone the repo(s) you want to work on, then create
`~/.config/trek-daemon/config.json`:

```json
{
  "repos": [
    { "id": "trek", "name": "Trek", "path": "/home/dev/repos/Trek" }
  ]
}
```

Worktrees are created as siblings of each repo (same convention as the app),
so the repo's parent directory is automatically allowed. Add `worktreeRoots`
for extra locations.

Generate the access token (prints once; stores only its sha256 hash):

```sh
trek-daemon token
```

Paste the token into the app under Settings → Servers. Rerunning the command
rotates the token and invalidates the old one.

## Run

```sh
trek-daemon                   # same as `trek-daemon start`; ws://127.0.0.1:7345
trek-daemon --port 7400 --config ./other-config.json
```

For real use, install the systemd user unit (see comments in
`trek-daemon.service`) so the daemon — and your Claude sessions — survive
logout and restart on boot.

## Expose it with Caddy (TLS)

The daemon binds loopback only and refuses public interfaces without TLS.
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

- **The token grants shell access as the daemon user.** `pty.spawn` starts a
  login shell. Treat the token like an SSH key; run the daemon as a dedicated
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
npm run smoke -- --built      # against dist/trek-daemon.cjs (run npm run build first)
```

Starts a throwaway daemon on loopback with a temp repo, exercises the
handshake, git listing, and a pty spawn/echo/kill round trip.
