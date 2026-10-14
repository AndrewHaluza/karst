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
export function sandboxGateDeps(gate: GateProcessRunner | undefined): {
  runGates?: typeof runGateList;
  runVerifier?: GateProcessRunner;
  fingerprint?: () => Promise<null>;
} {
  if (!gate) return {};
  return {
    runGates: (gates, cwd, opts = {}) => runGateList(gates, cwd, { ...opts, runProcess: gate }),
    runVerifier: gate,
    fingerprint: () => Promise.resolve(null),
  };
}
