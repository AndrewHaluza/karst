import type { KillOutcome } from '../../runtime/processTree.js';
import type { ProcessFactsSource } from '../../runtime/serverIdentity.js';
import { createGateRunRegistry, describeGateReap, reapOrphanedGates, type GateRunRegistry, type TrackedGate } from '../../runtime/gateRuns.js';

/** Test seams: a record directory, process probes and a kill function. */
export interface GateRunsSeams {
  dir?: string;
  hostPid?: number;
  startTime?: (pid: number) => Promise<number | null>;
  facts?: ProcessFactsSource;
  kill?: (pid: number) => KillOutcome;
}

export interface GateRunsBinding {
  registry: GateRunRegistry;
  /** Track a spawned gate beside another registration; the disposer runs both. */
  spawned(gate: TrackedGate, register: () => (() => void) | void): () => void;
  /** Reap the gate groups of a dead host (arch:GATE-ORPHANS). */
  reapOrphans(): Promise<void>;
}

/** Host-agnostic wiring of the gate-run registry and the activation reaper. */
export function bindGateRuns(log: {
  debug: (message: string) => void;
  info: (message: string) => void;
  error: (message: string, err: unknown) => void;
}, seams: GateRunsSeams = {}): GateRunsBinding {
  const registry = createGateRunRegistry({ ...seams, debug: log.debug });
  return {
    registry,
    spawned(gate, register) {
      const untrack = registry.track(gate);
      const unregister = register();
      return () => {
        untrack();
        if (typeof unregister === 'function') unregister();
      };
    },
    async reapOrphans() {
      try {
        for (const r of await reapOrphanedGates({ dir: seams.dir, facts: seams.facts, kill: seams.kill, debug: log.debug })) log.info(describeGateReap(r));
      } catch (err) {
        log.error('karst: orphaned-gate sweep failed', err);
      }
    },
  };
}
