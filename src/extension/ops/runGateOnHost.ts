import { listGateRuns } from '../../store/gateRuns.js';
import type { Store } from '../../store/db.js';
import { addHostGates } from '../../store/ticketGates.js';
import { EXIT_SIGKILL } from '../../workflow/gates/resourceKill.js';

/**
 * "Run gate on host" (resource-killed park): remember, for this ticket, that every
 * gate the stage last saw SIGKILLed reruns on the host. The caller then resumes
 * the stage. Returns the bare gate names recorded (empty when none was killed).
 *
 * `gate_runs.gate_name` is repo-decorated ("unit (web)"); the override matches the
 * bare name, as `disabled_gates` does.
 */
export function runKilledGatesOnHost(store: Store, ticketId: number, stageKey: string): string[] {
  const latest = new Map<string, { exit: number | null; bare: string }>();
  for (const r of listGateRuns(store, ticketId)) {
    if (r.stageKey !== stageKey || r.skipped) continue;
    const suffix = r.repo ? ` (${r.repo})` : '';
    const bare = suffix && r.gateName.endsWith(suffix) ? r.gateName.slice(0, -suffix.length) : r.gateName;
    latest.set(r.gateName, { exit: r.exitCode, bare });
  }
  const names = [...latest.values()].filter((v) => v.exit === EXIT_SIGKILL).map((v) => v.bare);
  if (names.length > 0) addHostGates(store, ticketId, names);
  return names;
}
