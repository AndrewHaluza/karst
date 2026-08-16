/**
 * AcpTransport (Slice 6 Task 1).
 *
 * ACP implements the SAME `AgentTransport` boundary as `SupervisedCLITransport`
 * and is selected only when the core supports it (`acpSupportedFor` — empty in
 * V1, so a core without ACP keeps `SupervisedCLITransport`). It mirrors the CLI
 * transport's lifecycle exactly:
 *
 * - owner nonce (CSPRNG ≥ 128 bits) persisted BEFORE the session starts;
 * - process/start identity and the launch generation recorded immediately
 *   after, including a null pid when the client reports none;
 * - every session registers with the existing `servers` registry keyed by its
 *   workspace `cwd`, so `removeWorktree` → `stopServersUnder` and the global
 *   `reapStaleServers` sweep both see it;
 * - graph sessions bypass `SessionManager` and are keyed `(ticketId,
 *   nodeRunId)` in the transport's own registry;
 * - termination is attributed exactly as the CLI transport's: `runtime/
 *   serverIdentity.ts` is the mandated evidence source, only `attributable`
 *   signals — via `killTree` on the process GROUP, with its return value
 *   checked (`denied` never reads as terminated).
 *
 * The DIFFERENCE is the launch vehicle and the boundary rules:
 * - instead of spawning a CLI it drives the injected `acp` client (launch a
 *   session for the node run, subscribe to events, request permission, cancel);
 * - an ACP `session-ended` / `cancelled` / `error` event maps to termination
 *   evidence ONLY — the accounting row closes as `interrupted` — never to an
 *   outcome; the guarded completion protocol (`karst node …`) is the only
 *   outcome path, exactly as for the CLI transport;
 * - a peer-delegation message is REFUSED (`refusePeerDelegation`), never
 *   forwarded;
 * - the endpoint must be loopback-bound with no remote callback addresses
 *   (`assertLoopbackEndpoint`); a non-loopback endpoint fails construction
 *   with a named error.
 *
 * V1 ships the transport + its boundary rules over the injected `acp` seam;
 * the host binds a real ACP client later. Host-agnostic: no vscode import.
 */

import type {
  AgentNodeLaunch,
  AgentTransport,
  AgentTransportCapabilities,
  SupervisedAgentSession,
  TerminationProof,
  TransportTerminal,
  TransportTerminalHost,
} from './agentTransport.js';
import {
  emitGraphDiagnostic,
  type GraphDiagnosticCategory,
  type GraphDiagnosticIdentity,
} from '../diagnostics.js';
import { killTree as systemKillTree, type KillOutcome } from '../../../runtime/processTree.js';
import { attributeServer, type ProcessFactsSource } from '../../../runtime/serverIdentity.js';

export type {
  AgentTransport,
  AgentNodeLaunch,
  SupervisedAgentSession,
  TerminationProof,
  TransportTerminal,
  TransportTerminalHost,
} from './agentTransport.js';

/** Named error for an ACP endpoint that is not loopback-bound. */
export class AcpEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpEndpointError';
  }
}

/** An ACP message the transport might forward (a stream of the session). */
export interface AcpMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /**
   * A destination node/agent a message names — peer delegation. Present means
   * the message asks ANOTHER node/agent to run graph work, which the transport
   * refuses.
   */
  targetNodeId?: string;
  /** A tool invocation; a peer-spawning tool name is delegation. */
  toolName?: string;
}

/** Tool names that spawn peers — delegation by tool, refused. */
const PEER_SPAWN_TOOLS: ReadonlySet<string> = new Set([
  'delegate',
  'delegate_agent',
  'spawn',
  'spawn_agent',
  'run_agent',
  'run_node',
  'dispatch',
  'assign',
]);

/**
 * REFUSE a message that would delegate graph work to a peer: either it names
 * another node/agent to run (`targetNodeId`) or it invokes a peer-spawning
 * tool (`toolName`). The transport never forwards a refused message — the ACP
 * client rejects it / the transport drops it. Pure and closed-vocabulary.
 */
export function refusePeerDelegation(message: AcpMessage): boolean {
  if (message.targetNodeId !== undefined && message.targetNodeId.length > 0) return true;
  if (message.toolName !== undefined && PEER_SPAWN_TOOLS.has(message.toolName)) return true;
  return false;
}

/** Loopback hostnames an ACP endpoint may be bound to. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * The ACP endpoint must be loopback-bound (127.0.0.1 / ::1 / localhost) with
 * no remote callback addresses: the host must resolve to loopback, and every
 * query-parameter value that parses as a URL must itself be loopback (a
 * `callback=` param pointing off-box is a remote callback address). Throws
 * `AcpEndpointError` — a named error — on any violation, so construction of a
 * transport against a remote endpoint fails loudly at the boundary.
 */
export function assertLoopbackEndpoint(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AcpEndpointError(`ACP endpoint is not a valid URL: ${url}`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new AcpEndpointError(
      `ACP endpoint must be loopback-bound (127.0.0.1/::1/localhost), got host "${parsed.hostname}"`,
    );
  }
  for (const value of parsed.searchParams.values()) {
    let candidate: URL;
    try {
      candidate = new URL(value);
    } catch {
      continue; // not a callback URL
    }
    if (!LOOPBACK_HOSTS.has(candidate.hostname)) {
      throw new AcpEndpointError(
        `ACP endpoint carries a remote callback address "${value}" (host "${candidate.hostname}")`,
      );
    }
  }
}

/** The ACP event vocabulary the transport consumes (lifecycle, never outcome). */
export type AcpEvent =
  | { type: 'session-ended'; reason: 'completed' | 'cancelled' | 'error'; message?: string }
  | { type: 'permission-requested'; requestId: string; prompt: string }
  | { type: 'message'; message: AcpMessage };

/** A live ACP session handle returned by the injected client. */
export interface AcpSessionHandle {
  sessionId: string;
  /** The underlying process pid if the client can report one, else null. */
  pid: number | null;
  /** Subscribe to the session's events. */
  onEvent(listener: (event: AcpEvent) => void): void;
  /** Reply to a `permission-requested` event. */
  requestPermission(requestId: string, allow: boolean): Promise<void>;
  /** Ask the core to cancel the session (best-effort, protocol-native). */
  cancel(): Promise<void>;
}

/** The injected ACP client seam — a THIN protocol abstraction. The host binds
 *  a real client later; V1 drives this seam and keeps the lifecycle logic pure. */
export interface AcpClient {
  startSession(input: AcpStartSessionInput): Promise<AcpSessionHandle>;
}

export interface AcpStartSessionInput {
  sessionName: string;
  cwd: string;
  env: Record<string, string>;
  initialPrompt: string;
}

/** The launch request this transport accepts: a node run + the composed seed
 *  prompt the ACP session starts with. No adapter — ACP launches the core
 *  directly, not through `AgentAdapter.buildInteractiveCommand`. */
export interface AcpLaunchRequest extends AgentNodeLaunch {
  /** The composed node prompt (node base prompt + context + instructions). */
  initialPrompt: string;
}

export interface AcpTransportDeps {
  /** The loopback-bound ACP endpoint the injected client attaches to. */
  endpoint: string;
  /** The injected ACP client seam. */
  acp: AcpClient;
  /** Register the session in the `servers` registry (cwd-keyed). */
  recordSession: (row: {
    ticketId: number;
    repo: string;
    pid: number | null;
    cwd: string;
    startedAt: string;
  }) => void;
  /** Attribution evidence; injected so tests never probe this machine. */
  facts?: ProcessFactsSource;
  /** Group signal; defaults to `runtime/processTree.ts` `killTree`. */
  killTree?: (pid: number) => KillOutcome;
  /** Open the graph launch's `process_runs` row — exactly one per launch. */
  openProcessRun?: (request: AcpLaunchRequest, pid: number | null) => number | undefined;
  /** Close the launch's `process_runs` row when its session ends. */
  closeProcessRun?: (
    processRunId: number,
    status: 'passed' | 'failed' | 'interrupted',
    now: string,
  ) => void;
  /** Surface a streamed (non-delegation) ACP message. */
  onMessage?: (nodeRunId: number, message: AcpMessage) => void;
  /** Surface a `permission-requested` event the core raised. */
  onPermissionRequest?: (event: { nodeRunId: number; requestId: string; prompt: string }) => void;
  now: () => string;
  debug?: (message: string) => void;
  /** Resolve a graph run's ticket identity (project slug, ticket key, stage
   *  attempt) for the structured diagnostics — the same seam the CLI transport
   *  uses, so both transports emit one keyed, bounded vocabulary. Absent → the
   *  keyed line is skipped (an unattributed run is not keyed). */
  graphIdentityOf?: (graphRunId: number) => GraphDiagnosticIdentity | undefined;
}

export interface AcpTransport extends AgentTransport {
  sessions(): SupervisedAgentSession[];
  sessionFor(ticketId: number, nodeRunId: number): SupervisedAgentSession | undefined;
  /** Reply to a `permission-requested` event the core raised. */
  requestPermission(ticketId: number, nodeRunId: number, requestId: string, allow: boolean): Promise<void>;
}

const CAPABILITIES: AgentTransportCapabilities = {
  exactModel: false,
  attributedTermination: true,
};

/** Cores the host may route to ACP. EMPTY in V1 — no core ships an ACP client,
 *  so every core keeps `SupervisedCLITransport`; the set grows only when the
 *  host can bind a real client for a core. */
const ACP_SUPPORTED_CORES: ReadonlySet<string> = new Set<string>([]);

/**
 * Selection: `acpSupportedFor(core)` is the ONE pure check the host consults.
 * A core without ACP keeps `SupervisedCLITransport`. V1 returns false for
 * every known core — nothing is forced at any call site.
 */
export function acpSupportedFor(core: string): boolean {
  return ACP_SUPPORTED_CORES.has(core);
}

export function createAcpTransport(deps: AcpTransportDeps): AcpTransport {
  assertLoopbackEndpoint(deps.endpoint);
  const facts = deps.facts;
  const killTree = deps.killTree ?? systemKillTree;
  const sessions = new Map<string, SupervisedAgentSession>();
  const handles = new Map<string, AcpSessionHandle>();
  /** Sessions whose accounting row already closed — an end event fires once. */
  const closed = new Set<string>();

  /**
   * One keyed, bounded diagnostic — the same emitter the CLI transport uses.
   * Every detail here is untrusted: an ACP peer's `reason`, and `String(error)`
   * over a client failure that may carry model output. The emitter collapses
   * and caps it and runs the redaction pipeline, which an ad-hoc debug string
   * would skip.
   */
  const diag = (
    category: GraphDiagnosticCategory,
    graphRunId: number,
    nodeRunId: number,
    generation: string | undefined,
    detail: string,
  ): void => {
    emitGraphDiagnostic(
      { debug: deps.debug, identityOf: deps.graphIdentityOf },
      { category, graphRunId, nodeRunId, generation, detail },
    );
  };

  return {
    capabilities: () => CAPABILITIES,

    async start(request: AcpLaunchRequest): Promise<SupervisedAgentSession> {
      // The ownership proof is the CALLER's, persisted inside the claim
      // transaction that moved the row out of `ready` — never minted here.
      const ownerNonce = request.ownerNonce;
      const handle = await deps.acp.startSession({
        sessionName: request.sessionName ?? `Karst node ${request.nodeRunId}`,
        cwd: request.cwd,
        env: request.graphEnv,
        initialPrompt: request.initialPrompt,
      });
      const pid = handle.pid ?? null;
      const startedAt = pid === null ? null : deps.now();
      let processRunId: number | null = null;
      if (deps.openProcessRun) {
        try {
          processRunId = deps.openProcessRun(request, pid) ?? null;
        } catch (error) {
          diag('launch', request.graphRunId, request.nodeRunId, request.generation,
            `opening the process_runs row failed (${String(error)}) — the launch continues unattributed`);
        }
      }
      const session: SupervisedAgentSession = {
        nodeRunId: request.nodeRunId,
        ticketId: request.ticketId,
        graphRunId: request.graphRunId,
        pid,
        cwd: request.cwd,
        generation: request.generation,
        ownerNonce,
        startedAt,
        processRunId,
        providerSessionId: handle.sessionId,
        terminal: undefined,
      };
      const key = `${request.ticketId}:${request.nodeRunId}`;
      sessions.set(key, session);
      handles.set(key, handle);
      handle.onEvent((event) => {
        switch (event.type) {
          case 'session-ended':
            // Termination evidence ONLY — never an outcome. The session ended
            // (whatever the reason); the accounting row closes `interrupted`
            // exactly like a killed/failed-to-start terminal does for the CLI
            // transport. The node OUTCOME is never written here — it arrives
            // only via the guarded completion protocol (`karst node …`).
            diag('close', request.graphRunId, request.nodeRunId, request.generation,
              `ACP session ended (${event.reason}) — termination evidence only, no outcome`);
            if (processRunId !== null && deps.closeProcessRun && !closed.has(key)) {
              closed.add(key);
              try {
                deps.closeProcessRun(processRunId, 'interrupted', deps.now());
              } catch (error) {
                diag('close', request.graphRunId, request.nodeRunId, request.generation,
                  `closing the process_runs row failed (${String(error)})`);
              }
            }
            // Terminal ACP sessions cannot receive another event, permission
            // response, or lifecycle action. Drop both registry entries so a
            // finished peer is never exposed as a live graph session and its
            // protocol handle cannot leak for the lifetime of the extension.
            sessions.delete(key);
            handles.delete(key);
            return;
          case 'permission-requested':
            deps.onPermissionRequest?.({ nodeRunId: request.nodeRunId, ...event });
            return;
          case 'message':
            if (refusePeerDelegation(event.message)) {
              diag('block', request.graphRunId, request.nodeRunId, request.generation,
                'refused an ACP peer-delegation message');
              return;
            }
            deps.onMessage?.(request.nodeRunId, event.message);
            return;
        }
      });
      // Last, and swallowed: the peer is ALIVE and already registered, so a
      // locked database must never reject `start` and leave it tracked by
      // nothing — untrackable by `sessions()`, unreachable by `terminate`,
      // never closed out. The CLI transport swallows the same write for the
      // same reason (869ed2n50).
      try {
        deps.recordSession({
          ticketId: request.ticketId,
          repo: request.repo,
          pid,
          cwd: request.cwd,
          startedAt: startedAt ?? deps.now(),
        });
      } catch (error) {
        diag('launch', request.graphRunId, request.nodeRunId, request.generation,
          `recording the servers row failed (${String(error)}) — the session is tracked in memory only`);
      }
      return session;
    },

    async terminate(session: SupervisedAgentSession): Promise<TerminationProof> {
      // The protocol-native cancel is a best-effort first ask; the PROOF still
      // comes from attributed termination — a denied/unknown kill never reads
      // as terminated, exactly as for the CLI transport.
      const handle = handles.get(`${session.ticketId}:${session.nodeRunId}`);
      if (handle) {
        try {
          await handle.cancel();
        } catch (error) {
          diag('close', session.graphRunId, session.nodeRunId, session.generation,
            `ACP cancel failed (${String(error)}) — attribution still decides`);
        }
      }
      if (session.pid === null) {
        diag('close', session.graphRunId, session.nodeRunId, session.generation,
          'terminate for a session that never started — nothing to signal');
        return { kind: 'unknown' };
      }
      if (!facts) {
        diag('close', session.graphRunId, session.nodeRunId, session.generation,
          'terminate without attribution facts — refusing to signal');
        return { kind: 'unknown' };
      }
      const [alive, liveCwd, processStartMs] = await Promise.all([
        facts.isAlive(session.pid),
        facts.liveCwd(session.pid),
        facts.processStartMs(session.pid),
      ]);
      const attribution = attributeServer(
        { pid: session.pid, cwd: session.cwd, startedAt: session.startedAt },
        { isAlive: () => alive, liveCwd: () => liveCwd, processStartMs: () => processStartMs },
      );
      switch (attribution) {
        case 'attributable':
          return { kind: 'attributable', kill: killTree(session.pid) };
        case 'dead':
          return { kind: 'dead' };
        case 'foreign':
          return { kind: 'foreign' };
        case 'unknown':
          return { kind: 'unknown' };
      }
    },

    sessions: () => [...sessions.values()],
    sessionFor: (ticketId, nodeRunId) => sessions.get(`${ticketId}:${nodeRunId}`),

    async requestPermission(ticketId, nodeRunId, requestId, allow): Promise<void> {
      const handle = handles.get(`${ticketId}:${nodeRunId}`);
      if (handle) await handle.requestPermission(requestId, allow);
    },
  };
}
