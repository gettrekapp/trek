# Colima environments (built-in plugin `env`)

One Colima VM per worktree's branch (`twb-<branch>-<hash>`), with the worktree's docker compose
inside it, on the Trek server's machine. macOS and Linux only: a Windows server lists the plugin
as not available and has no `env.*` methods.

- **Wire:** `env.check`, `env.list`, `env.up`, `env.stop`, `env.destroy`, `env.ps`,
  `env.composeFiles`, `env.logs`, and the `env.log` event (to the asking connection only), with
  the names and payloads core had before plugins E2 (PROTOCOL.md, "Docker, environments and stacks").
- **Teardown:** `env:destroy` stops and deletes the worktree's VM before a remove, promote or move;
  a repository is not removed while a VM of its worktrees runs.
- **Settings:** per repository (`enabled`, `cpu`, `memory`, `disk`, `networkAddress`, `rosetta`,
  `composeFile`, `profileKey`) and per branch (`env`, the .env text). For one release the server
  mirrors them under their old names, `Repository.environments` and `BranchData.env`.
- **Data:** the VM registry in `<dataDir>/plugins/env/environments.json` (0600). It is copied once
  from `<dataDir>/environments.json`, or a Local server takes it over from the app's data dir with
  `--import-env-from`.
- **Code:** `shared/` (profile names, .env parsing, types), `server/` (colima and docker through
  the host's programs). The window's Env panel, chips and Settings tab move here in plugins E3.
