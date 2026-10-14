import type { Manifest } from '../manifest/types.js';
import { unitByKey } from '../manifest/runnable.js';
import type { Store } from '../store/db.js';
import type { SessionRunner, StepOutcome } from './sessionRunner.js';

/**
 * Baseline (shared) services stay on the host (arch:AC-32). A sandbox reaches
 * one ONLY through an explicit per-port allow generated from the manifest: the
 * declared default ports of the ticket's baseline services. Nothing else on
 * the host is reachable — sbx gets a per-sandbox policy rule, docker an exact
 * `host.docker.internal:<port>` entry in its allowlist proxy.
 */
export function baselineHostPorts(manifest: Manifest, baselineKeys: readonly string[]): number[] {
  const ports = new Set<number>();
  for (const key of baselineKeys) {
    for (const slot of unitByKey(manifest, key)?.def.ports ?? []) ports.add(slot.default);
  }
  return [...ports].sort((a, b) => a - b);
}

/** The ticket's recorded baseline references (`baseline_refs`). */
export function ticketBaselineKeys(store: Store, ticketId: number): string[] {
  return (store.db.prepare('SELECT repo FROM baseline_refs WHERE ticket_id = ?').all(ticketId) as { repo: string }[]).map((r) => r.repo);
}

/** sbx: apply the per-sandbox rule. docker applies it at prepare (the proxy env), so this is a no-op there. */
export async function allowBaselineHostPorts(runner: Pick<SessionRunner, 'allowHostPorts'>, ports: readonly number[]): Promise<StepOutcome> {
  if (ports.length === 0 || !runner.allowHostPorts) return { ok: true };
  return runner.allowHostPorts(ports);
}
