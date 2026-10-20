import type { GateProcessRunner } from './run.js';
import { runGateList } from './runList.js';

/**
 * The stage deps that move a ticket's gates into its sandbox (arch:AC-32).
 * Absent runner → `{}`, so a host ticket's stages are byte-identical.
 *
 * The gate-skip fingerprint is turned off: it hashes the HOST worktree, which
 * a sandbox's edits do not reach until sync, so a stale match would reuse an
 * old verdict for new code.
 */
export function sandboxGateDeps(gate: GateProcessRunner | undefined, hostGate?: () => GateProcessRunner): {
  runGates?: typeof runGateList;
  runVerifier?: GateProcessRunner;
  fingerprint?: () => Promise<null>;
} {
  if (!gate) return {};
  return {
    // A fresh host runner per list: its one-time sync/dirty check covers exactly this run.
    runGates: (gates, cwd, opts = {}) =>
      runGateList(gates, cwd, { ...opts, runProcess: gate, ...(hostGate && gates.some((g) => g.sandbox === 'host') ? { hostProcess: hostGate() } : {}) }),
    runVerifier: gate,
    fingerprint: () => Promise.resolve(null),
  };
}
