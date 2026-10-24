import type { Store } from './db.js';
import type { Manifest } from '../manifest/types.js';
import { serviceUnits } from '../manifest/runnable.js';
import { resolveBaselineBranch } from '../manifest/baselineBranch.js';
import { listPinnedBaselines } from './baselinePins.js';
import { isLiveBaselineDependent, listBaselineDependentsDetailed } from './baselineRefs.js';

/**
 * The project-wide server inventory behind the Servers panel: SELECT-only, like
 * `runningServers.ts` — observing never mutates. Positional `?` binding only.
 *
 * Scope mirrors the Resource Monitor: baseline (shared) rows are never
 * project-scoped, ticket stacks are limited to the project's tickets.
 */

export interface InventoryServer {
  id: number;
  repo: string;
  host: string | null;
  port: number | null;
  status: string;
  startedAt: string | null;
  logPath: string | null;
  container: string | null;
  cwd: string | null;
  sandbox: string | null;
}

/** A live ticket that consumes a shared service; `done` = finished but its stack still runs. */
export interface InventoryDependent {
  ticketId: number;
  key: string | null;
  title: string | null;
  done: boolean;
}

export interface SharedServer extends InventoryServer {
  pinned: boolean;
  /** The base branch the shared copy serves; null when the manifest cannot say. */
  baseBranch: string | null;
  dependents: InventoryDependent[];
}

export interface TicketServerGroup {
  ticketId: number;
  key: string | null;
  title: string | null;
  stage: string | null;
  archived: boolean;
  /** `stage_current = 'done'` — its servers are leftovers of a finished ticket. */
  done: boolean;
  /** A shared service this ticket depends on is not running. */
  dependencyDown: boolean;
  /** Unit keys of the dependencies that are down (for "dependency down: api"). */
  downServices: string[];
  servers: InventoryServer[];
}

export interface ServerInventory {
  shared: SharedServer[];
  tickets: TicketServerGroup[];
}

interface ServerDbRow {
  id: number;
  ticketId: number | null;
  repo: string;
  host: string | null;
  port: number | null;
  status: string;
  startedAt: string | null;
  logPath: string | null;
  container: string | null;
  cwd: string | null;
  sandbox: string | null;
}

const SERVER_COLUMNS =
  's.id, s.ticket_id AS ticketId, s.repo, s.host, s.port, s.status, s.started_at AS startedAt, ' +
  's.log_path AS logPath, s.container, s.cwd, s.sandbox';

function toServer(row: ServerDbRow): InventoryServer {
  return {
    id: row.id,
    repo: row.repo,
    host: row.host,
    port: row.port,
    status: row.status,
    startedAt: row.startedAt,
    logPath: row.logPath,
    container: row.container,
    cwd: row.cwd,
    sandbox: row.sandbox,
  };
}

const running = (s: { status: string }): number => (s.status === 'running' ? 0 : 1);

function byRunningThenRepo(a: InventoryServer, b: InventoryServer): number {
  return running(a) - running(b) || a.repo.localeCompare(b.repo) || a.id - b.id;
}

function sharedServers(store: Store, manifest: Manifest): SharedServer[] {
  const declared = new Map(serviceUnits(manifest).map((u) => [u.key, u]));
  const rows = store.db
    .prepare(
      `SELECT ${SERVER_COLUMNS} FROM servers s
        WHERE s.ticket_id IS NULL AND s.kind = 'service' ORDER BY s.id`,
    )
    .all() as ServerDbRow[];
  // One row per unit: retained stopped rows are normal, so a running row wins
  // over a retired one and the newest wins among equals.
  const best = new Map<string, ServerDbRow>();
  for (const row of rows) {
    if (!declared.has(row.repo)) continue;
    const cur = best.get(row.repo);
    if (!cur || running(row) < running(cur) || (running(row) === running(cur) && row.id > cur.id)) {
      best.set(row.repo, row);
    }
  }
  const pins = listPinnedBaselines(store);
  return [...best.values()]
    .map((row): SharedServer => ({
      ...toServer(row),
      pinned: pins.has(row.repo),
      baseBranch: resolveBaselineBranch(manifest, declared.get(row.repo)!.repoDef),
      dependents: listBaselineDependentsDetailed(store, row.repo)
        .filter(isLiveBaselineDependent)
        .map((d) => ({
          ticketId: d.ticketId,
          key: d.key,
          title: d.title,
          done: d.stageCurrent === 'done',
        })),
    }))
    .sort(byRunningThenRepo);
}

function ticketGroups(store: Store, projectId: number): TicketServerGroup[] {
  const rows = store.db
    .prepare(
      `SELECT ${SERVER_COLUMNS}, t.key AS tkey, t.title AS ttitle,
              t.stage_current AS stage, (t.archived_at IS NOT NULL) AS archived
         FROM servers s JOIN tickets t ON t.id = s.ticket_id
        WHERE t.project_id = ? AND s.kind = 'service'
          AND (t.archived_at IS NULL OR s.status = 'running')
        ORDER BY s.id`,
    )
    .all(projectId) as Array<
    ServerDbRow & { tkey: string | null; ttitle: string | null; stage: string | null; archived: number }
  >;
  const downByTicket = new Map<number, string[]>();
  const groups = new Map<number, TicketServerGroup>();
  for (const row of rows) {
    const ticketId = row.ticketId!;
    let group = groups.get(ticketId);
    if (!group) {
      const down = downDependencies(store, ticketId);
      downByTicket.set(ticketId, down);
      group = {
        ticketId,
        key: row.tkey,
        title: row.ttitle,
        stage: row.stage,
        archived: row.archived === 1,
        done: row.stage === 'done',
        dependencyDown: down.length > 0,
        downServices: down,
        servers: [],
      };
      groups.set(ticketId, group);
    }
    group.servers.push(toServer(row));
  }
  const out = [...groups.values()];
  for (const g of out) g.servers.sort(byRunningThenRepo);
  const anyRunning = (g: TicketServerGroup): number => (g.servers.some((s) => s.status === 'running') ? 0 : 1);
  return out.sort((a, b) => anyRunning(a) - anyRunning(b) || a.ticketId - b.ticketId);
}

function downDependencies(store: Store, ticketId: number): string[] {
  const refs = store.db
    .prepare(
      `SELECT b.repo FROM baseline_refs b
        WHERE b.ticket_id = ?
          AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.repo = b.repo AND s.ticket_id IS NULL
                            AND s.kind = 'service' AND s.status = 'running')
        ORDER BY b.repo`,
    )
    .all(ticketId) as { repo: string }[];
  return refs.map((r) => r.repo);
}

/**
 * Every server this project can act on: shared services the manifest declares
 * (running and stopped) and the ticket stacks of the project. A `baseline_refs`
 * entry with no row is not a server here — the ticket panel shows those.
 */
export function listProjectServers(
  store: Store,
  manifest: Manifest,
  projectId: number,
): ServerInventory {
  return { shared: sharedServers(store, manifest), tickets: ticketGroups(store, projectId) };
}
