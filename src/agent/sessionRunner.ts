import { runProcess, type GateProcessRunner } from '../workflow/gates/run.js';
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

export type SyncResult =
  | { readonly ok: true; readonly summary: string }
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

export interface SessionRunner {
  readonly kind: 'host' | 'sbx' | 'docker';
  /**
   * True only when the runner itself enforces a sandbox boundary. Autonomous
   * permissions may only be granted when this is true (arch:AC-31, fail closed).
   */
  readonly enforcesSandbox: boolean;
  placeInteractive(spec: InteractiveLaunchSpec): PlacedInteractiveLaunch;
  runHeadless: RunHeadless;
  /** Sandbox runners only: where the AGENT sees the bridge dir (host runner: undefined). */
  bridgeRunDir?(paths: BridgePaths): string;
  /** Sandbox runners only: bring the sandbox's commits into the host worktree (fast-forward or refuse). */
  sync?(ticket: SandboxTicketRef): Promise<SyncResult>;
  /** Sandbox runners only: remove the sandbox and everything it left on the host. */
  dispose?(ticket: SandboxTicketRef): Promise<void>;
  /**
   * Sandbox runners only: does this ticket's sandbox exist? A session that
   * failed closed to the host has none, so its gates and services stay on the host.
   */
  hasSandbox?(): Promise<boolean>;
  /** Sandbox runners only: publish ONE declared port on `127.0.0.1` (arch:AC-32). */
  publishPort?(mapping: PortMapping): Promise<PublishResult>;
  unpublishPort?(mapping: PortMapping): Promise<void>;
  /** Sandbox runners only: the live mappings; null when the sandbox cannot answer (not running). */
  listPorts?(): Promise<readonly PortMapping[] | null>;
  /** Sandbox runners only: let the sandbox reach exactly these host ports (baseline services). */
  allowHostPorts?(ports: readonly number[]): Promise<StepOutcome>;
  /**
   * Where a gate runs. The host runner's is `runProcess` itself (zero behaviour
   * change); a sandbox runner execs into the sandbox, against the live edits.
   */
  runGate?: GateProcessRunner;
}

export function createHostSessionRunner(
  spawnHeadless: RunHeadless = (command, args, cwd, opts) =>
    spawnHeadlessCli(command, args, cwd, opts),
  runGate: GateProcessRunner = runProcess,
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
    runGate,
  };
}

export const HOST_SESSION_RUNNER: SessionRunner = createHostSessionRunner();
