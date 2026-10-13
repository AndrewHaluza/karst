import {
  spawnHeadlessCli,
  type HeadlessSpawnOptions,
  type HeadlessSpawnResult,
} from './headlessSpawn.js';

/**
 * The execution-location seam (Docker plan Increment 1). Adapters build the
 * provider command; a runner decides WHERE it runs. Today there is one runner,
 * the host, which reproduces the pre-seam behaviour exactly. A later sandbox
 * runner (Docker clone mode) slots in here without SessionManager or the
 * adapters learning about it.
 *
 * `hostWorktreePath` is the ticket worktree on the host; the placed `cwd` is
 * the path the command sees. They are equal on the host and MAY differ in a
 * sandbox (the ST2 spike found a directly-mounted linked worktree breaks git;
 * clone mode does not) — callers must use the placed `cwd`, never assume it.
 */
export interface InteractiveLaunchSpec {
  readonly ticketId: number;
  readonly hostWorktreePath: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** What the terminal host is asked to create. */
export interface PlacedInteractiveLaunch {
  readonly cwd: string;
  readonly shellPath: string;
  readonly shellArgs: string[];
  readonly env: Record<string, string>;
}

export type RunHeadless = (
  command: string,
  args: string[],
  cwd: string,
  opts?: HeadlessSpawnOptions,
) => Promise<HeadlessSpawnResult>;

/** Host-side handle of a ticket's sandbox: where its edits land, and on which branch. */
export interface SandboxTicketRef {
  readonly hostWorktreePath: string;
  readonly branch: string;
}

export type SyncResult =
  | { readonly ok: true; readonly summary: string }
  | { readonly ok: false; readonly reason: string };

export interface SessionRunner {
  readonly kind: 'host' | 'sbx';
  /**
   * True only when the runner itself enforces a sandbox boundary. Autonomous
   * permissions may only be granted when this is true (arch:AC-31, fail closed).
   */
  readonly enforcesSandbox: boolean;
  placeInteractive(spec: InteractiveLaunchSpec): PlacedInteractiveLaunch;
  runHeadless: RunHeadless;
  /** Sandbox runners only: bring the sandbox's commits into the host worktree (fast-forward or refuse). */
  sync?(ticket: SandboxTicketRef): Promise<SyncResult>;
  /** Sandbox runners only: remove the sandbox and everything it left on the host. */
  dispose?(ticket: SandboxTicketRef): Promise<void>;
}

export function createHostSessionRunner(
  spawnHeadless: RunHeadless = (command, args, cwd, opts) =>
    spawnHeadlessCli(command, args, cwd, opts),
): SessionRunner {
  return {
    kind: 'host',
    enforcesSandbox: false,
    placeInteractive: (spec) => ({
      cwd: spec.hostWorktreePath,
      shellPath: spec.command,
      shellArgs: [...spec.args],
      env: { ...spec.env },
    }),
    runHeadless: spawnHeadless,
  };
}

export const HOST_SESSION_RUNNER: SessionRunner = createHostSessionRunner();
