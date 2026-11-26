/**
 * The AgentTransport boundary (design, "Agent Transport Boundary").
 *
 * Graph semantics depend on an injected `AgentTransport`, never directly on
 * provider CLI construction. `SupervisedCLITransport` is the SOLE bridge from
 * `AgentAdapter` to this interface (pinned by an import-graph test) —
 * `AgentAdapter` stays a static command-and-environment builder and gains no
 * lifecycle methods.
 *
 * Transport termination must produce positive process/session lifecycle
 * evidence; terminal disposal alone is insufficient. A `TerminationProof` is
 * an ATTRIBUTED process-group signal (`runtime/serverIdentity.ts` is the
 * mandated evidence source — no invented probe), with the kill outcome
 * checked: `killed`, `denied`, and `unknown` are three different facts, and
 * `denied` (still running, refused) never reads as terminated — the caller
 * keeps the row `running` and the lease held.
 *
 * The attribution outcomes map onto node statuses by the CALLER: `dead` →
 * the node is marked stale and the graph blocks for recoverable retry;
 * `foreign` → the recorded pid was reissued, the row is cleared and nothing
 * is signalled; `unknown` → `termination-unknown`, leases retained, never
 * automatically retried.
 */

import type { KillOutcome } from '../../../runtime/processTree.js';

export interface AgentTransportCapabilities {
  /** The transport can prove which model a session ran under. */
  exactModel: boolean;
  /** Termination produces an attributed, verified process-group signal. */
  attributedTermination: boolean;
}

/** A host-created terminal surface the transport can supervise. */
export interface TransportTerminal {
  /** Resolve once the terminal's process exists; undefined when it never
   *  started (captured immediately after spawn — this is the identity the
   *  supervision records). */
  processId(): Promise<number | undefined>;
  show(preserveFocus?: boolean): void;
  sendText(text: string): void;
  dispose(): void;
  onDidClose(handler: (exitCode?: number) => void): void;
  /**
   * Observe the bytes the provider writes to the terminal, when the host can.
   * Optional, and NOT satisfied by the VS Code host: VS Code exposes terminal
   * output only through a proposed API a shipped extension cannot use, so the
   * shipped extension leaves this absent — the launch-failure reason then
   * carries no captured line rather than a fabricated one. It stays on the seam
   * for a host that really can observe writes (tests, a future pty-backed host).
   */
  onDidWriteData?(handler: (data: string) => void): void;
}

export interface TransportTerminalHost {
  createTerminal(opts: CreateTransportTerminalOpts): TransportTerminal;
}

export interface CreateTransportTerminalOpts {
  name: string;
  cwd: string;
  shellPath: string;
  shellArgs: string[];
  env: Record<string, string>;
  hideFromUser?: boolean;
  /** The karst brand mark for the terminal tab (a path to the logo asset). */
  iconPath?: string;
  /**
   * The resolved core/model the launch runs with. Recorded in the window's
   * terminal registry so a sweep that selects terminals by PROVIDER (the
   * claude/agy usage watches) sees a graph session exactly like a ticket
   * session — a graph terminal carries no `session_launch_intents` row.
   */
  identity?: { provider: string; model?: string | null; agentName?: string | null };
}

/** The identity a graph launch resolved to: the profile id and the provider,
 *  model and effort it runs with. Recorded on the run row at `launching → running`. */
export interface LaunchIdentity {
  profile: string;
  provider: string;
  model?: string;
  effort?: string;
  /** The account this role is pinned to (a user pick at a usage-limit park,
   *  @arch:AC-55). Absent → the active account of the core. */
  account?: string;
}

/** One node activation's launch request. */
export interface AgentNodeLaunch {
  nodeRunId: number;
  /**
   * Which run table `nodeRunId` names. A graph NODE launch passes its node-run
   * id (the default); a PLANNER launch passes its planner-run id — the two
   * tables have independent id sequences, so a consumer that must resolve the
   * row (the launch-failure parker) has to know which one it holds, or it can
   * park an unrelated node run that happens to share the id.
   */
  runKind?: 'node' | 'planner';
  ticketId: number;
  graphRunId: number;
  /** The repository whose worktree the session runs in (`servers.repo`). */
  repo: string;
  /** The workspace directory — also the `servers.cwd` the reapers match on. */
  cwd: string;
  /** The launch generation, frozen for this launch attempt. */
  generation: string;
  /**
   * The launch's ownership proof (CSPRNG ≥ 128 bits), frozen for this attempt
   * exactly like `generation` — and, like it, persisted by the CALLER inside
   * the same transaction that moves the row out of `ready`. A transport must
   * never mint its own: the nonce written after the claim commits leaves the
   * row observable to another window as `launching` with no launch identity,
   * which is the shape "provably never spawned" is read from.
   */
  ownerNonce: string;
  sessionName?: string;
  /** The karst brand mark for the terminal tab; `sessionName` stays the text. */
  sessionIconPath?: string;
  /** Graph-environment additions (KARST_GRAPH_*) composed by the launcher;
   *  merged over the adapter-built environment. */
  graphEnv: Record<string, string>;
  /** The resolved launch identity. `process_runs` takes its provider from here,
   *  never from the adapter binary name. */
  identity?: LaunchIdentity;
}

/** A supervised, running (or failed-to-start) graph session. */
export interface SupervisedAgentSession {
  nodeRunId: number;
  ticketId: number;
  graphRunId: number;
  /** The process group leader pid, or null when the terminal never started. */
  pid: number | null;
  cwd: string;
  generation: string;
  /** CSPRNG ≥ 128 bits, persisted BEFORE spawn — the retry's ownership proof. */
  ownerNonce: string;
  /** When the pid was obtained (captured at that moment, never at INSERT). */
  startedAt: string | null;
  /**
   * The `process_runs` row this launch opened (Slice-3 T10) — the binding the
   * interactive usage sampler attaches observations to. NULL when the host
   * supplied no accounting hook (an unreportable transport) — never a
   * fabricated row, and never a fabricated zero.
   */
  processRunId: number | null;
  /**
   * The provider this launch resolved to (from `request.identity.provider`).
   * Absent/NULL when the host supplied no identity — the provider is then
   * unknown and is never guessed from the adapter binary. A consumer that
   * selects sessions by provider (the claude usage sweep) reads it directly.
   */
  provider?: string | null;
  /**
   * The provider session id. A claude launch gets a karst-chosen `randomUUID()`
   * at spawn (T1370, passed as `--session-id`), so its transcript is locatable
   * while it runs; every other core records `null` until a lifecycle channel
   * reports one.
   */
  providerSessionId: string | null;
  /**
   * Which run table `nodeRunId` names (the request's `runKind`; absent = a node
   * run). The usage sweep needs it to build the graph launch id: planner-run
   * and node-run ids are independent sequences. Optional so a session that was
   * re-attached, or a fake, still type-checks; absent reads as `node`.
   */
  runKind?: 'node' | 'planner';
  /**
   * The host terminal surface (CLI transport). Absent for a transport with no
   * terminal (ACP drives the session over its protocol instead) — a session
   * without one must never fabricate a terminal it does not own.
   */
  terminal?: TransportTerminal;
}

export type TerminationProof =
  | { kind: 'attributable'; kill: KillOutcome }
  | { kind: 'dead' }
  | { kind: 'foreign' }
  | { kind: 'unknown' };

export interface AgentTransport {
  capabilities(): AgentTransportCapabilities;
  start(request: AgentNodeLaunch): Promise<SupervisedAgentSession>;
  terminate(session: SupervisedAgentSession): Promise<TerminationProof>;
}
