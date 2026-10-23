import { runProcess, type GateProcessRunner } from '../workflow/gates/run.js';
import type { DisposeResult } from './disposeResult.js';
import type { BridgePaths } from './bridge/bridgeDir.js';
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
  /**
   * Host path of the per-ticket evidence-bridge dir (arch:AC-34). Sandbox
   * runners mount it read-write as the ONLY extra mount; the host runner
   * ignores it.
   */
  readonly bridgeDir?: string;
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

/** `stashMessage`: park the clone's uncommitted work with `git stash push -u -m <it>` before refreshing (never discarded). */
export interface RefreshOptions {
  readonly stashMessage?: string;
  /** A conflict is open: bundle `origin/<baseRef>` too, so the clone gets `refs/karst/base/<baseRef>` to merge (arch:AC-39). */
  readonly baseRef?: string;
}

/**
 * Does a ticket's sandbox exist? `unknown` is a CLI that cannot answer (not on the
 * extension host PATH, daemon down, signed out): never read it as `absent`, or a
 * sandboxed ticket's commits are skipped silently (arch:AC-39).
 */
export type SandboxProbe =
  | { readonly state: 'present' }
  | { readonly state: 'absent' }
  | { readonly state: 'unknown'; readonly reason: string };

export type SyncResult =
  | { readonly ok: true; readonly summary: string }
  | { readonly ok: false; readonly reason: string };

/** The sandbox's commits not yet on the host branch, as a unified diff (never merged). */
export type DiffResult =
  | { readonly ok: true; readonly diff: string; readonly ref: string }
  | { readonly ok: false; readonly reason: string };

/** One published service port: host side always `127.0.0.1:<hostPort>`. */
export interface PortMapping {
  readonly hostPort: number;
  readonly sandboxPort: number;
}

export type PublishResult =
  | { readonly ok: true }
  /** `portTaken`: the host port is busy, so a reallocation may succeed. */
  | { readonly ok: false; readonly reason: string; readonly portTaken: boolean };

export type StepOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type { GateProcessRunner };

export type SetupWindow =
  | { readonly ok: true; readonly close: () => Promise<void> }
  | { readonly ok: false; readonly reason: string };

export interface SessionRunner {
  readonly kind: 'host' | 'sbx' | 'docker';
  /**
   * True only when the runner itself enforces a sandbox boundary. Autonomous
   * permissions may only be granted when this is true (arch:AC-31, fail closed).
   */
  readonly enforcesSandbox: boolean;
  /** The core runs here without permission prompts (arch:AC-31); diagnostics only. */
  readonly autonomous?: boolean;
  placeInteractive(spec: InteractiveLaunchSpec): PlacedInteractiveLaunch;
  /** Ticket-bound headless calls are host-only (arch:AC-33): a sandbox runner has none, only the host runner does. */
  runHeadless?: RunHeadless;
  /** Sandbox runners only: where the AGENT sees the bridge dir (host runner: undefined). */
  bridgeRunDir?(paths: BridgePaths): string;
  /** Sandbox runners only: bring the sandbox's commits into the host worktree (fast-forward or refuse). */
  sync?(ticket: SandboxTicketRef): Promise<SyncResult>;
  /** Sandbox runners only: host → sandbox (F8): fast-forward the clone to the host branch; dirty clone or divergence is refused, never overwritten. */
  refresh?(ticket: SandboxTicketRef, opts?: RefreshOptions): Promise<SyncResult>;
  /** Sandbox runners only: fetch the clone's branch into the host worktree's FETCH_HEAD; merges nothing (carry classification). */
  fetchClone?(ticket: SandboxTicketRef): Promise<StepOutcome>;
  /** Sandbox runners only: `git diff <host branch>...<sandbox branch>` after fetching; changes nothing on the host branch. */
  diff?(ticket: SandboxTicketRef): Promise<DiffResult>;
  /** Sandbox runners only: stop the sandbox, keeping it for the next open (arch:AC-32 lifecycle). */
  stop?(): Promise<void>;
  /** Sandbox runners only: remove the sandbox and everything it left on the host. */
  dispose?(ticket: SandboxTicketRef): Promise<DisposeResult>;
  /**
   * Sandbox runners only: does this ticket's sandbox exist? A session that
   * failed closed to the host has none, so its gates and services stay on the host.
   */
  hasSandbox?(): Promise<boolean>;
  /** Sandbox runners only: the tri-state behind `hasSandbox` (a CLI that cannot run is `unknown`, not `absent`). */
  probeSandbox?(): Promise<SandboxProbe>;
  /**
   * Sandbox runners only: can a long-lived service run there NOW? docker:
   * while the interactive container runs, else a detached hardened service
   * container is started on the clone volume (a gate's one-shot container
   * exits with its command); sbx: whenever the sandbox exists (exec starts it).
   */
  canHostServices?(): Promise<boolean>;
  /** docker: remove the detached service container once the ticket's services are stopped. */
  stopServices?(): Promise<void>;
  /** Sandbox runners only: publish ONE declared port on `127.0.0.1` (arch:AC-32). */
  publishPort?(mapping: PortMapping): Promise<PublishResult>;
  unpublishPort?(mapping: PortMapping): Promise<void>;
  /** Sandbox runners only: the live mappings; null when the sandbox cannot answer (not running). */
  listPorts?(): Promise<readonly PortMapping[] | null>;
  /** Sandbox runners only: let the sandbox reach exactly these host ports (baseline services). */
  allowHostPorts?(ports: readonly number[]): Promise<StepOutcome>;
  /**
   * Sandbox runners only: open the network for exactly these hosts (port 443) for the setup step; `close`
   * undoes exactly what open added, so baseline allows stay. docker recreates its proxy (`windowNeedsIdle`).
   */
  setupWindow?(hosts: readonly string[]): Promise<SetupWindow>;
  /** docker: a window recreates the proxy and cuts live connections, so only an idle agent may open one. */
  readonly windowNeedsIdle?: boolean;
  /**
   * Where a gate runs. The host runner's is `runProcess` itself (zero behaviour
   * change); a sandbox runner execs into the sandbox, against the live edits.
   */
  runGate?: GateProcessRunner;
}

export type HostSessionRunner = SessionRunner & { readonly runHeadless: RunHeadless };

export function createHostSessionRunner(
  spawnHeadless: RunHeadless = (command, args, cwd, opts) =>
    spawnHeadlessCli(command, args, cwd, opts),
  runGate: GateProcessRunner = runProcess,
): HostSessionRunner {
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
    runGate,
  };
}

export const HOST_SESSION_RUNNER: HostSessionRunner = createHostSessionRunner();
