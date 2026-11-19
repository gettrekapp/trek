// The Colima plugin's types (plugins E2): what env.* take and answer, and env.log's payload. Copied
// from src/shared/types.ts, whose copies stay for the renderer and protocolV2.ts until plugins E3.

/** Settings for per-worktree isolated Docker environments (Colima VMs). */
export interface EnvironmentSettings {
  /** Feature opt-in (default off) */
  enabled: boolean
  /** VM CPUs (default 2) */
  cpu?: number
  /** VM memory in GiB (default 4) */
  memory?: number
  /** VM disk in GiB (default 20) */
  disk?: number
  /**
   * Give each VM its own reachable IP via --network-address (default on).
   * Needs Colima's vmnet sudo helper; when off, ports forward to localhost
   * and fixed host ports collide across worktrees again.
   */
  networkAddress?: boolean
  /**
   * Run x86_64 images via Rosetta 2 (default off). Switches new VMs to
   * Apple's VZ runtime (--vm-type vz --vz-rosetta); Apple Silicon only.
   */
  rosetta?: boolean
  /**
   * Compose file path relative to the worktree (default "docker-compose.yml").
   * May be a comma-separated list — each file becomes a -f flag, layered in
   * order (e.g. "docker-compose.yml,docker-compose.override.yml").
   */
  composeFile?: string
  /**
   * The repository path this repository's VM names hash, when it is not `path`: set by
   * a .trekproj import whose file had another spelling of the path (a symlink, `/var`
   * for `/private/var`, a trailing slash). See envRepoKey.
   */
  profileKey?: string
}

export type EnvVmState = 'running' | 'stopped' | 'missing'

/** A known environment: registry entry merged with live `colima list` state. */
export interface EnvironmentInfo {
  profile: string
  repoPath: string
  branch: string
  worktreePath: string
  vmState: EnvVmState
  /** VM IP when running with --network-address */
  address?: string
  /** Compose file(s) the environment was last started with (comma-separated) */
  composeFile?: string
  /**
   * Registry entry whose worktree no longer exists on disk, or a twb- Colima
   * profile with no registry entry (e.g. left behind by a crash).
   */
  orphaned?: boolean
}

export interface EnvServicePort {
  published: number
  target: number
  protocol: string
}

/** One compose service inside an environment. */
export interface EnvService {
  name: string
  /** compose state: running, exited, ... */
  state: string
  /** human status line */
  status: string
  ports: EnvServicePort[]
}

/** Phases of an env:up run, for progress display. */
export type EnvUpStep = 'vm' | 'compose' | 'ready'

export interface EnvLogEvent {
  profile: string
  data: string
  /** true on the final event of an operation */
  done?: boolean
  /** marks the start of an env:up phase */
  step?: EnvUpStep
}

/** Result of env:up — nonzero code means failure; error is the friendly reason. */
export interface EnvUpResult {
  code: number
  /** VM IP when running with --network-address */
  address?: string
  error?: string
}

export interface EnvCheckResult {
  ok: boolean
  colimaVersion?: string
  dockerVersion?: string
  /** why the toolchain is unusable, e.g. "colima not found on PATH" */
  error?: string
}
