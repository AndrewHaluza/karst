import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { unitByKey, unitsOfRepos, resolveTarget } from '../manifest/runnable.js';
import { resolve, transitiveDependents } from '../resolver/resolve.js';
import { makeRecordedPortAllocator } from '../resolver/recordedAllocator.js';
import { makePortAllocator } from '../resolver/allocator.js';
import { startResolvedService } from './startService.js';
import { getEnvOverrides } from '../store/ticketEnvOverrides.js';
import { stopServer, type ServerRecord } from './supervisor.js';
import { allocationRanges, hotRepoPaths } from './spin.js';
import { portsToAvoid } from './portProbe.js';

/**
 * Start exactly one already-spun service of a ticket — the host-agnostic
 * operation behind the dashboard Servers panel's per-row Start/Restart.
 *
 * Two invariants this path preserves:
 *
 *  - No other service is stopped by the RECORDED path. Only the named repo's
 *    own `running` row is retired; every peer's row and process is left as it
 *    was, and ports never move when they are recorded.
 *  - No worktree is created or removed. The service starts in its recorded
 *    worktree; a missing one is a typed failure telling the user to spin.
 *
 * When the target has NO recorded allocation — allocations are wiped by spin
 * rollback/teardown, or the service was added to the manifest after the spin —
 * the row is not dead: it RECOVERS. Fresh ports are drawn for its missing slots
 * from the same range/override windows a spin uses (probing for listeners karst
 * cannot reclaim), the target is started on them, and every dependent that is
 * currently running is restarted in `startOrder` so its env carries the new
 * peer URL. A recorded peer keeps its port; a stopped, non-baseline peer the
 * target depends on is allocated too, so the target's env names a recorded port
 * (a declared baseline keeps its shared default). A dependent left stopped stays
 * stopped — its next start reads the recorded port.
 *
 * `spinTicket` is deliberately NOT reused: it stops EVERY server of the ticket,
 * releases and reallocates every port, and re-creates worktrees. Calling it with
 * a single-element hot set would still stop the user's other running services
 * and re-port them.
 */
export class StartServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartServiceError';
  }
}

export interface StartTicketServiceOpts {
  signal?: AbortSignal;
  onReclaim?: (pid: number) => void;
  debug?: (message: string) => void;
  /**
   * Live-listener discovery for the RECOVERY allocator, injected so tests never
   * depend on this machine's open ports. Defaults to `runtime/portProbe.ts`.
   * The recorded path never probes — no port moves.
   */
  probeBusyPorts?: (
    host: string,
    ranges: readonly (readonly [number, number])[],
    repoPaths: readonly string[],
  ) => Promise<Set<number>>;
}

export interface StartTicketServiceResult {
  /** The started target's registry row. */
  record: ServerRecord;
  /**
   * Slot → port freshly allocated to the TARGET because it had no record.
   * Empty on the recorded path, where every port is unchanged.
   */
  newPorts: Record<string, number>;
  /**
   * Unit keys of the target's running dependents restarted so their env carries
   * the new peer URL, in `startOrder`. Empty on the recorded path.
   */
  restartedDependents: string[];
}

/** The unit keys with a `running` registry row for this ticket. */
function runningUnitKeys(store: Store, ticketId: number): Set<string> {
  const rows = store.db
    .prepare("SELECT repo FROM servers WHERE ticket_id = ? AND status = 'running'")
    .all(ticketId) as { repo: string }[];
  return new Set(rows.map((r) => r.repo));
}

/** Stop the named unit's running row, if any, before it is (re)started. */
async function stopRunning(store: Store, ticketId: number, name: string): Promise<void> {
  const row = store.db
    .prepare("SELECT id FROM servers WHERE ticket_id = ? AND repo = ? AND status = 'running'")
    .get(ticketId, name) as { id: number } | undefined;
  if (row) await stopServer(store, row.id);
}

export async function startTicketService(
  store: Store,
  manifest: Manifest,
  ticketId: number,
  repoName: string,
  opts: StartTicketServiceOpts = {},
): Promise<StartTicketServiceResult> {
  opts.debug?.(`[runtime] ticket ${ticketId}: row-start requested for ${repoName}`);
  // `repoName` is a service unit key: the repository name, or `repo/service`.
  const unit = unitByKey(manifest, repoName);
  if (unit === undefined) {
    const known = manifest.repositories[repoName.split('/')[0]!];
    throw new StartServiceError(
      known === undefined
        ? `"${repoName}" is no longer in the manifest — re-spin the ticket.`
        : `"${repoName}" declares no service — there is nothing to start.`,
    );
  }
  const repo = unit.repoDef;

  const wtRows = store.db
    .prepare('SELECT repo, path FROM worktrees WHERE ticket_id = ?')
    .all(ticketId) as { repo: string; path: string }[];
  // `worktrees.repo` stores the repository PATH (see `createWorktree`), while
  // the manifest is keyed by NAME — so map the name to its repoPath before the
  // lookup, or every start would report "no worktree".
  const pathByRepo = new Map(wtRows.map((r) => [r.repo, r.path]));
  const cwd = pathByRepo.get(repo.repoPath);
  if (cwd === undefined) {
    throw new StartServiceError(
      `"${repoName}" has no worktree for this ticket — spin the ticket first.`,
    );
  }

  // The hot set is the ticket's RECORDED allocations, not its worktree rows:
  // `port_allocations.repo` is the manifest name, and a port that was released
  // is not one we may reuse. Requiring an allocation for a peer that no longer
  // has one would block starting the target for no reason; a peer that still
  // has its recording keeps its exact port in every dependent's env.
  const recordedRows = store.db
    .prepare('SELECT repo, port_name AS portName, port FROM port_allocations WHERE ticket_id = ?')
    .all(ticketId) as { repo: string; portName: string; port: number }[];
  const recorded = new Map<string, Map<string, number>>();
  for (const row of recordedRows) {
    const slots = recorded.get(row.repo);
    if (slots) slots.set(row.portName, row.port);
    else recorded.set(row.repo, new Map([[row.portName, row.port]]));
  }
  // Allocation rows are keyed by unit key; `resolve` takes the REPOSITORY hot
  // set, so map each back to its repository (deduped — sibling services share one).
  const hot = [
    ...new Set(
      [...recorded.keys()]
        .map((key) => unitByKey(manifest, key)?.repo)
        .filter((name): name is string => name !== undefined),
    ),
  ];
  if (!hot.includes(unit.repo)) hot.push(unit.repo);

  const targetSlots = unit.def.ports.map((p) => p.name);
  const recordedForTarget = recorded.get(unit.key);
  const targetFullyAllocated = targetSlots.every((s) => recordedForTarget?.has(s) ?? false);

  // Retire the target's own running row before (re)starting it, in both paths.
  await stopRunning(store, ticketId, repoName);

  if (targetFullyAllocated) {
    // Recorded path — byte-for-byte the old behaviour: playback of the ticket's
    // recorded ports, no port moves, no dependent restarts.
    const resolved = resolve(manifest, hot, makeRecordedPortAllocator(store, ticketId), ticketId);
    const envOverrides = getEnvOverrides(store, ticketId);
    const rec = await startResolvedService({
      store,
      manifest,
      ticketId,
      name: repoName,
      resolved,
      cwd,
      envOverrides,
      signal: opts.signal,
      onReclaim: opts.onReclaim,
      debug: opts.debug,
    });
    opts.debug?.(`[runtime] ticket ${ticketId}: ${repoName} healthy (pid ${rec.pid})`);
    return { record: rec, newPorts: {}, restartedDependents: [] };
  }

  // --- Recovery: the target has no recorded port(s) to play back. ---
  const running = runningUnitKeys(store, ticketId);
  // A dependency the ticket already declared as a BASELINE is a shared singleton
  // on its default port — allocating it an alt port would wire the target to
  // where nothing listens. Only a peer that was part of this ticket's hot set
  // (and so lost its own allocation) is safe to re-draw.
  const baselineKeys = new Set(
    (
      store.db.prepare('SELECT repo FROM baseline_refs WHERE ticket_id = ?').all(ticketId) as {
        repo: string;
      }[]
    ).map((r) => r.repo),
  );

  // An unrecorded, stopped direct dependency still needs a recorded port when
  // the target's env names it — otherwise the target is wired to the peer's
  // default while the peer's own row-start would draw a different alt port.
  // A running peer is left as-is (its port cannot be re-drawn without a restart
  // it did not ask for); a baseline peer and an unrelated peer are skipped
  // exactly as before.
  for (const dep of unit.def.dependsOn) {
    const target = resolveTarget(manifest.repositories, dep.target);
    if ('error' in target) continue;
    const depUnit = target.unit;
    const have = recorded.get(depUnit.key);
    const depRecorded = depUnit.def.ports.every((p) => have?.has(p.name) ?? false);
    if (depRecorded || running.has(depUnit.key) || baselineKeys.has(depUnit.key)) continue;
    if (!hot.includes(depUnit.repo)) hot.push(depUnit.repo);
  }

  const probe =
    opts.probeBusyPorts ??
    ((host, ranges, repoPaths) => portsToAvoid(store, host, ranges, repoPaths, { debug: opts.debug }));
  const busy = await probe(
    manifest.host,
    allocationRanges(manifest, hot),
    hotRepoPaths(manifest, hot),
  );
  if (busy.size > 0) {
    opts.debug?.(
      `[runtime] ticket ${ticketId}: ${busy.size} occupied port(s) excluded from recovery allocation`,
    );
  }
  const fresh = makePortAllocator(store, manifest.portRange, { busy });
  // Draw only the MISSING slots per unit, so a recorded port never moves. One
  // transaction: a range that exhausts mid-way records nothing rather than
  // leaving half a service allocated.
  store.db.transaction(() => {
    for (const hotUnit of unitsOfRepos(manifest, hot)) {
      const have = recorded.get(hotUnit.key);
      const missing = hotUnit.def.ports
        .map((p) => p.name)
        .filter((name) => !(have?.has(name) ?? false));
      if (missing.length === 0) continue;
      fresh.allocate(ticketId, hotUnit.key, missing, hotUnit.def.portRange ?? manifest.portRange);
      opts.debug?.(
        `[runtime] ticket ${ticketId}: allocated ${missing.join(', ')} for ${hotUnit.key} (no record)`,
      );
    }
  })();

  const resolved = resolve(manifest, hot, makeRecordedPortAllocator(store, ticketId), ticketId);
  const newPorts: Record<string, number> = {};
  for (const slot of targetSlots) {
    if (!(recordedForTarget?.has(slot) ?? false)) {
      newPorts[slot] = resolved.services[unit.key]!.ports[slot]!;
    }
  }

  const envOverrides = getEnvOverrides(store, ticketId);
  const rec = await startResolvedService({
    store,
    manifest,
    ticketId,
    name: repoName,
    resolved,
    cwd,
    envOverrides,
    signal: opts.signal,
    onReclaim: opts.onReclaim,
    debug: opts.debug,
  });
  opts.debug?.(
    `[runtime] ticket ${ticketId}: ${repoName} healthy (pid ${rec.pid}, new port ` +
      `${Object.values(newPorts).join(', ')})`,
  );

  // Rewire only the dependents that are RUNNING right now, in startOrder so a
  // dependent starts after anything it depends on. A stopped dependent keeps
  // its recorded port and picks it up on its next start; the target stays up
  // even if one dependent fails — that failure is reported per service.
  const dependents = new Set(transitiveDependents(manifest, unit.key));
  const restartedDependents: string[] = [];
  for (const name of resolved.startOrder) {
    if (name === unit.key || !dependents.has(name) || !running.has(name)) continue;
    const depUnit = unitByKey(manifest, name)!;
    const depCwd = pathByRepo.get(depUnit.repoDef.repoPath);
    if (depCwd === undefined) {
      throw new StartServiceError(
        `Started ${repoName} on the new port, but "${name}" has no worktree for this ticket — ` +
          're-spin the ticket to rewire it.',
      );
    }
    await stopRunning(store, ticketId, name);
    try {
      await startResolvedService({
        store,
        manifest,
        ticketId,
        name,
        resolved,
        cwd: depCwd,
        envOverrides,
        signal: opts.signal,
        onReclaim: opts.onReclaim,
        debug: opts.debug,
      });
    } catch (err) {
      throw new StartServiceError(
        `Started ${repoName} on the new port, but restarting dependent "${name}" failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    restartedDependents.push(name);
    opts.debug?.(`[runtime] ticket ${ticketId}: restarted dependent ${name} for new peer port`);
  }

  return { record: rec, newPorts, restartedDependents };
}
