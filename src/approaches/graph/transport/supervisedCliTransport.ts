/**
 * SupervisedCLITransport (Slice 3 Task 3).
 *
 * The SOLE bridge from `AgentAdapter` to `AgentTransport` (pinned by an
 * import-graph test): it calls `buildInteractiveCommand`, owns the spawn and
 * the supervision on top of it, and `AgentAdapter` gains no lifecycle
 * methods. No other module bridges the two interfaces.
 *
 * Supervision contract:
 * - the owner nonce (CSPRNG ≥ 128 bits) is persisted BEFORE spawn — the
 *   retry's ownership proof, never written after the fact;
 * - process group/PID, process start identity (captured at the moment the pid
 *   is obtained), and the launch generation are recorded immediately after
 *   spawn, including a null pid when the terminal never started;
 * - every session registers with the existing `servers` registry keyed by its
 *   workspace `cwd`, so `removeWorktree` → `stopServersUnder` and the global
 *   `reapStaleServers` sweep both see it — the 869ed2n50 detached-process
 *   class, by name;
 * - graph sessions bypass `SessionManager` entirely and are keyed
 *   `(ticketId, nodeRunId)` in the transport's own registry.
 *
 * Termination produces positive lifecycle evidence only:
 * `runtime/serverIdentity.ts` is the mandated attribution source (live cwd
 * via `/proc/<pid>/cwd` where the OS provides it, else start time via
 * `ps -o lstart=` within `START_TIME_TOLERANCE_MS`, both sides canonicalized
 * through `runtime/pathScope.ts`). Only `attributable` signals — via
 * `killTree` on the process GROUP, with its return value checked: `denied`
 * never reads as terminated, the lease stays held and the row stays
 * truthfully `running`. `dead`/`foreign`/`unknown` signal nothing; the caller
 * maps them onto node statuses (design, "Process attribution").
 *
 * Host-agnostic: terminal host, store writes, probes and clock are injected.
 */

import { randomBytes } from 'node:crypto';
import type {
  AgentNodeLaunch,
  AgentTransport,
  AgentTransportCapabilities,
  SupervisedAgentSession,
  TerminationProof,
  TransportTerminal,
  TransportTerminalHost,
} from './agentTransport.js';
import type { AgentAdapter, InteractiveCommandOpts } from '../../../agent/adapter.js';
import { killTree as systemKillTree, type KillOutcome } from '../../../runtime/processTree.js';
import { attributeServer, type ProcessFactsSource } from '../../../runtime/serverIdentity.js';

export type {
  AgentAdapter,
  InteractiveCommandOpts,
} from '../../../agent/adapter.js';
export type {
  AgentTransport,
  AgentNodeLaunch,
  SupervisedAgentSession,
  TerminationProof,
} from './agentTransport.js';

export interface SupervisedTransportDeps {
  terminalHost: TransportTerminalHost;
  /** Persist the owner nonce on the node run — MUST run before spawn. */
  persistOwnerNonce: (nodeRunId: number, nonce: string) => void;
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
  now: () => string;
  debug?: (message: string) => void;
}

/** The launch request this transport accepts: the adapter it bridges FROM,
 *  the interactive opts it builds with, and the launcher's graph env. */
export interface SupervisedLaunchRequest extends AgentNodeLaunch {
  adapter: AgentAdapter;
  interactive: InteractiveCommandOpts;
}

export interface SupervisedCliTransport extends AgentTransport {
  sessions(): SupervisedAgentSession[];
  sessionFor(ticketId: number, nodeRunId: number): SupervisedAgentSession | undefined;
}

const CAPABILITIES: AgentTransportCapabilities = {
  exactModel: false,
  attributedTermination: true,
};

export function createSupervisedCliTransport(deps: SupervisedTransportDeps): SupervisedCliTransport {
  const facts = deps.facts;
  const killTree = deps.killTree ?? systemKillTree;
  /** Graph sessions bypass SessionManager — keyed (ticketId, nodeRunId). */
  const sessions = new Map<string, SupervisedAgentSession>();

  return {
    capabilities: () => CAPABILITIES,

    async start(request: SupervisedLaunchRequest): Promise<SupervisedAgentSession> {
      const ownerNonce = randomBytes(16).toString('hex');
      deps.persistOwnerNonce(request.nodeRunId, ownerNonce);
      const built = request.adapter.buildInteractiveCommand({
        ...request.interactive,
        cwd: request.cwd,
      });
      const terminal = deps.terminalHost.createTerminal({
        name: request.sessionName ?? `Karst node ${request.nodeRunId}`,
        cwd: request.cwd,
        shellPath: built.command,
        shellArgs: built.args,
        env: { ...built.env, ...request.graphEnv },
      });
      const pid = (await terminal.processId()) ?? null;
      // A null pid is still a launch attempt: the row is recorded so the
      // executor can tell `failed-to-launch` from never-claimed. The start
      // identity (session.startedAt) is only captured when a pid exists.
      const startedAt = pid === null ? null : deps.now();
      deps.recordSession({
        ticketId: request.ticketId,
        repo: request.repo,
        pid,
        cwd: request.cwd,
        startedAt: startedAt ?? deps.now(),
      });
      const session: SupervisedAgentSession = {
        nodeRunId: request.nodeRunId,
        ticketId: request.ticketId,
        graphRunId: request.graphRunId,
        pid,
        cwd: request.cwd,
        generation: request.generation,
        ownerNonce,
        startedAt,
        providerSessionId: null,
        terminal,
      };
      sessions.set(`${request.ticketId}:${request.nodeRunId}`, session);
      return session;
    },

    async terminate(session: SupervisedAgentSession): Promise<TerminationProof> {
      if (session.pid === null) {
        deps.debug?.('[graph] terminate for a session that never started — nothing to signal');
        return { kind: 'unknown' };
      }
      if (!facts) {
        deps.debug?.('[graph] transport terminate without attribution facts — refusing to signal');
        return { kind: 'unknown' };
      }
      const [alive, liveCwd, processStartMs] = await Promise.all([
        facts.isAlive(session.pid),
        facts.liveCwd(session.pid),
        facts.processStartMs(session.pid),
      ]);
      // `attributeServer` is the pure decision (runtime/serverIdentity.ts is
      // the mandated evidence source); the probes were awaited above so both
      // synchronous and asynchronous fact sources feed the same decision.
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
  };
}
