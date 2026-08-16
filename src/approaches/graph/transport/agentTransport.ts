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
}

/** One node activation's launch request. */
export interface AgentNodeLaunch {
  nodeRunId: number;
  ticketId: number;
  graphRunId: number;
  /** The repository whose worktree the session runs in (`servers.repo`). */
  repo: string;
  /** The workspace directory — also the `servers.cwd` the reapers match on. */
  cwd: string;
  /** The launch generation, frozen for this launch attempt. */
  generation: string;
  sessionName?: string;
  /** The karst brand mark for the terminal tab; `sessionName` stays the text. */
  sessionIconPath?: string;
  /** Graph-environment additions (KARST_GRAPH_*) composed by the launcher;
   *  merged over the adapter-built environment. */
  graphEnv: Record<string, string>;
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
  /** Provider session id — recorded via the lifecycle channel, later. */
  providerSessionId: string | null;
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
