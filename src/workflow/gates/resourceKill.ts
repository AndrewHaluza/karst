import type { GateResult } from './result.js';

/** A gate's `onResourceKill`: retry once lighter then park (default), park at once, or rerun on the host. */
export type ResourceKillPolicy = 'retry-then-park' | 'park' | 'host';
export const RESOURCE_KILL_POLICIES: readonly ResourceKillPolicy[] = ['retry-then-park', 'park', 'host'];

/** The env var the vitest configs read to cap their worker pool for the lighter retry. */
export const GATE_MAX_WORKERS_ENV = 'KARST_GATE_MAX_WORKERS';

/** 128 + SIGKILL(9): the kernel OOM killer's signature, and a container runtime's `OOMKilled`. */
export const EXIT_SIGKILL = 137;

/** What a test runner prints when a test genuinely failed, as opposed to being killed mid-run. */
const FAILURE_MARKERS = [
  /^\s*FAIL\b/m,
  /\bAssertionError\b/,
  /^\s*[×✗✖]\s/m,
  /\b[1-9]\d* failed\b/,
  /^\s*\d+\) /m,
];

/**
 * True when the gate was SIGKILLed and printed no failing test: an ENVIRONMENT
 * fault (memory pressure), not a verdict — the same principle as
 * arch:GATE-CAPABILITY. A 137 beside a real failing test stays an ordinary failure.
 */
export function isResourceKill(result: GateResult): boolean {
  if (result.exitCode !== EXIT_SIGKILL) return false;
  return !FAILURE_MARKERS.some((re) => re.test(result.output));
}

/** Gates whose name the ticket asked to rerun on the host get `onResourceKill: 'host'`. */
export function withHostOverride<G extends { name: string; onResourceKill?: ResourceKillPolicy }>(
  gates: readonly G[],
  hostNames: readonly string[],
): G[] {
  if (hostNames.length === 0) return [...gates];
  return gates.map((g) => (hostNames.includes(g.name) ? { ...g, onResourceKill: 'host' as const } : g));
}

/** The park reason when any gate stayed resource-killed after its policy ran, else null. */
export function resourceKilledReason(results: readonly GateResult[]): string | null {
  const killed = results.filter((r) => r.resourceKilled !== undefined);
  if (killed.length === 0) return null;
  // A gate that failed for an ordinary reason is the ticket's to fix; the park must not swallow it.
  if (results.some((r) => r.resourceKilled === undefined && r.exitCode !== null && r.exitCode !== 0)) return null;
  return killed.map((r) => r.resourceKilled).join(' | ');
}

/** The park reason for a gate that was resource-killed even after the lighter retry. */
export function resourceKillReason(gate: string, sandboxed: boolean): string {
  const where = sandboxed ? 'in the sandbox' : 'on the host';
  const hint = sandboxed
    ? ' The Docker VM memory is shared by every ticket sandbox — raise the Docker Desktop memory, or run the gate on the host.'
    : ' The machine ran out of memory — free memory and retry.';
  return `gate "${gate}" was killed (exit ${EXIT_SIGKILL}, SIGKILL) ${where} with no failing test — out of memory, not a code failure.${hint}`;
}
