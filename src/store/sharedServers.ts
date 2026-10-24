import type { Store } from './db.js';
import type { Manifest } from '../manifest/types.js';
import { resolveBaselineBranch } from '../manifest/baselineBranch.js';
import { unitByKey } from '../manifest/runnable.js';
import { baselineCheckoutDir } from '../runtime/baselinePaths.js';
import { formatId } from '../model/entityId.js';
import {
  isLiveBaselineDependent,
  listBaselineDependentsDetailed,
  type BaselineDependent,
} from './baselineRefs.js';

/** Why a ref cannot render a service at all. */
const NO_LONGER_DECLARED = 'no longer declared in karst.yml';

/**
 * One shared (baseline) service a ticket consumes, ready to render. The shared
 * half is read-only in the ticket panel: a stop affects every other consumer, so
 * control lives in the project view.
 */
export interface SharedServerView {
  /** The baseline `servers.id`; null when no row exists (the ref is `missing`). */
  id: number | null;
  /**
   * The manifest unit key — `api`, or `api/web` for a `services:` entry — and
   * how the unit renders: the key IS the display name.
   */
  service: string;
  status: 'running' | 'stopped' | 'failed' | 'missing';
  host: string | null;
  port: number | null;
  logPath: string | null;
  container: string | null;
  /** The base branch the shared copy serves; null when the unit left the manifest. */
  baseBranch: string | null;
  /** The shared checkout on disk; null when the unit left the manifest. */
  checkoutPath: string | null;
  /** `shared with T412, T418` — the live dependents OTHER than this ticket. */
  sharedWith: string;
  /** Why a `missing` ref cannot run; null for every other status. */
  missingReason: string | null;
  /** Every ticket that declared this dependency, raw (archived included). */
  dependents: BaselineDependent[];
}

interface BaselineRow {
  id: number;
  host: string | null;
  port: number | null;
  status: string;
  log_path: string | null;
  container: string | null;
}

function statusOf(row: BaselineRow | undefined): SharedServerView['status'] {
  if (!row) return 'missing';
  if (row.status === 'running') return 'running';
  if (row.status === 'failed') return 'failed';
  return 'stopped';
}

/**
 * The shared services ONE ticket consumes: for each of its `baseline_refs`
 * edges, the baseline `servers` row it points at (`ticket_id IS NULL`,
 * `kind = 'service'`), plus the manifest facts that say where that copy runs.
 *
 * The manifest is read ONLY here and only for a ref's own repository: a unit
 * renamed out of `karst.yml` is reported `missing` with the reason, never an
 * exception — the panel must be able to describe a wiring that no longer
 * resolves.
 */
export function listSharedServersByTicket(
  store: Store,
  manifest: Manifest,
  ticketId: number,
): SharedServerView[] {
  const refs = store.db
    .prepare('SELECT repo FROM baseline_refs WHERE ticket_id = ? ORDER BY repo')
    .all(ticketId) as { repo: string }[];

  return refs.map(({ repo: key }) => {
    const unit = unitByKey(manifest, key);
    // Retained stopped rows are normal (stopServer marks, never deletes), so a
    // running row wins over a retired one; the newest is the best of equals.
    const row = store.db
      .prepare(
        `SELECT id, host, port, status, log_path, container FROM servers
          WHERE repo = ? AND ticket_id IS NULL AND kind = 'service'
          ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, id DESC
          LIMIT 1`,
      )
      .get(key) as BaselineRow | undefined;

    const dependents = listBaselineDependentsDetailed(store, key);
    const others = dependents
      .filter((d) => d.ticketId !== ticketId && isLiveBaselineDependent(d))
      .map((d) => d.key ?? formatId('ticket', d.ticketId));

    return {
      id: row?.id ?? null,
      service: key,
      // A unit that left the manifest cannot run, even if its old row survives.
      status: unit ? statusOf(row) : 'missing',
      host: row?.host ?? null,
      port: row?.port ?? null,
      logPath: row?.log_path ?? null,
      container: row?.container ?? null,
      baseBranch: unit ? resolveBaselineBranch(manifest, unit.repoDef) : null,
      // ONE checkout per REPOSITORY (`unit.repo`), shared by sibling services.
      checkoutPath: unit ? baselineCheckoutDir(unit.repoDef.repoPath, unit.repo) : null,
      sharedWith: others.length > 0 ? `shared with ${others.join(', ')}` : 'no other live tickets',
      missingReason: unit ? null : NO_LONGER_DECLARED,
      dependents,
    };
  });
}
