/**
 * User UAT on a HOST stack (`uat.keepStackForUser`, arch:AC-32 decisions 7-8
 * extended to the host). Host-agnostic: the store and the process boundary are
 * injected, so this runs under vitest with fakes.
 */
import type { Store } from '../../store/db.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';

/** One reset may take this long before it counts as failed (same budget as a sandbox reset). */
export const HOST_RESET_TIMEOUT_MS = 30_000;

interface HostRow {
  readonly repo: string;
  readonly cwd: string | null;
}

const HOST_ROWS_SQL =
  "SELECT repo, cwd FROM servers WHERE ticket_id = ? AND status = 'running' AND sandbox IS NULL AND kind = 'service' ORDER BY repo";

function hostRows(store: Store, ticketId: number): HostRow[] {
  return store.db.prepare(HOST_ROWS_SQL).all(ticketId) as HostRow[];
}

/** Does the ticket have a running service on the host (not in a sandbox)? */
export function hasRunningHostServices(store: Store, ticketId: number): boolean {
  return hostRows(store, ticketId).length > 0;
}

/**
 * Run each running host service's declared `reset` (`sh -c`) in the directory
 * the service was spawned in. The row's `cwd` already includes the service's
 * own `cwd`, so it is used as is. A service without a reset is left as the
 * Tester left it. Returns one warning per reset that did not complete with 0;
 * a failure never throws, so the stack stays kept.
 */
export async function resetHostServices(
  store: Store,
  ticketId: number,
  resetOf: (unitKey: string) => { readonly reset?: string } | undefined,
  run: GateProcessRunner,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const row of hostRows(store, ticketId)) {
    const reset = resetOf(row.repo)?.reset;
    if (!reset) continue;
    if (row.cwd === null) {
      warnings.push(`${row.repo}: reset skipped (no recorded directory)`);
      continue;
    }
    try {
      const out = await run('sh', ['-c', reset], row.cwd, { timeoutMs: HOST_RESET_TIMEOUT_MS });
      if (out.kind === 'completed' && out.exitCode === 0) continue;
      warnings.push(
        out.kind === 'completed'
          ? `${row.repo}: reset failed (exit ${out.exitCode}: ${out.output.trim()})`
          : `${row.repo}: reset failed (${out.kind}: ${out.output.trim()})`,
      );
    } catch (error) {
      warnings.push(`${row.repo}: reset failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return warnings;
}
