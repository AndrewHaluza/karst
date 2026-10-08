import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import type { ServerRecord } from '../runtime/supervisor.js';

/**
 * `karst setup verify [--repos a,b]` — the setup session's verification phase.
 *
 * A setup session has no ticket, so `servers spin` (which requires one) cannot
 * run. The baseline singleton, however, is already ticketless: `ensureBaseline`
 * starts a manifest service with `ticket_id NULL`, health-gates it, and records
 * a `servers` row. This verb runs that path for the proposed manifest's
 * services, one at a time, and reports each outcome so the agent can loop —
 * fixing the manifest and re-verifying — until every service is healthy, or
 * stop and report the blocker.
 *
 * Chosen over a throwaway ticket context because it reuses the existing,
 * well-tested baseline path and allocates NO ticket id, worktree, or port slot
 * that a real ticket would later collide with.
 */

export interface ParsedSetupVerifyArgs {
  /** `--repos a,b` split and trimmed; empty when the flag was absent. */
  repos: string[];
}

export function parseSetupVerifyArgs(rest: readonly string[]): ParsedSetupVerifyArgs {
  const [cmd, sub, ...flags] = rest;
  if (cmd !== 'setup' || sub !== 'verify') {
    throw new Error(`expected 'setup verify', got '${cmd ?? ''} ${sub ?? ''}'`.trim());
  }
  const repos: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--repos') {
      const value = flags[++i];
      if (value === undefined) throw new Error('karst setup verify: --repos needs a value');
      repos.push(...value.split(',').map((r) => r.trim()).filter((r) => r !== ''));
    } else {
      throw new Error(`karst setup verify: unknown argument '${flags[i]}'`);
    }
  }
  return { repos };
}

/** The manifest repositories to verify: those with a service, filtered by name. */
export function selectVerifyServices(manifest: Manifest, repos: readonly string[]): string[] {
  const all = Object.entries(manifest.repositories)
    .filter(([, def]) => def.service !== undefined)
    .map(([name]) => name);
  if (repos.length === 0) return all;
  const requested = new Set(repos);
  return all.filter((name) => requested.has(name));
}

export interface VerifyResult {
  service: string;
  ok: boolean;
  port?: number;
  error?: string;
}

export type StartBaseline = (
  store: Store,
  manifest: Manifest,
  service: string,
) => Promise<ServerRecord>;

/**
 * Start each selected service via the injected baseline starter, capturing a
 * per-service outcome. Never throws on a service failure: the agent needs the
 * whole picture to decide what to fix.
 */
export async function runSetupVerifyCommand(
  store: Store,
  manifest: Manifest,
  parsed: ParsedSetupVerifyArgs,
  startBaseline: StartBaseline,
): Promise<string> {
  const services = selectVerifyServices(manifest, parsed.repos);
  const results: VerifyResult[] = [];
  for (const service of services) {
    try {
      const record = await startBaseline(store, manifest, service);
      results.push({ service, ok: true, port: record.port });
    } catch (e) {
      results.push({ service, ok: false, error: (e as Error).message });
    }
  }
  // An EMPTY selection is not a pass. `every` over an empty array is vacuously
  // true, so a mistyped `--repos` or a manifest whose repositories declare no
  // service used to return a clean `{ok:true,services:[]}` — indistinguishable
  // from a genuine all-healthy run, and the agent would report "every service is
  // healthy" without having spun a single process. Fail with a reason instead.
  if (services.length === 0) {
    return JSON.stringify({
      ok: false,
      services: results,
      error:
        parsed.repos.length > 0
          ? `no requested repository declares a service: ${parsed.repos.join(', ')}`
          : 'no repository in the manifest declares a service',
    });
  }
  return JSON.stringify({ ok: results.every((r) => r.ok), services: results });
}
