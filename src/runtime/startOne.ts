import type { Store } from '../store/db.js';
import type { Manifest, PortSlot, ServiceDef } from '../manifest/types.js';
import { unitByKey, unitsOfRepos, resolveTarget } from '../manifest/runnable.js';
import { resolve, transitiveDependents } from '../resolver/resolve.js';
import { makeRecordedPortAllocator } from '../resolver/recordedAllocator.js';
import { makePortAllocator, type PortAllocator } from '../resolver/allocator.js';
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
 * cannot reclaim), the target is started on them, and the units the target's
 * wiring touches are recovered with it: every RUNNING dependent is restarted in
 * `startOrder` so its env carries the new peer URL, and a RUNNING direct
 * dependency contributes its LIVE port (recovered from its `servers` row) to
 * the target's env. A recorded port never moves; a stopped, non-baseline direct
 * dependency is allocated a port so the target's env names a recorded one (a
 * declared baseline keeps its shared default). A stopped dependent stays stopped
 * — its next start reads the recorded port.
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

/**
 * The slot whose port a unit's `servers` row records — `startResolvedService`
 * launches the `http` slot (or the first declared) as the service's own port.
 */
function primaryPortSlot(def: ServiceDef): PortSlot | undefined {
  return def.ports.find((p) => p.name === 'http') ?? def.ports[0];
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
  // The `servers` row of a running unit names the port it is ACTUALLY listening
  // on, even when the allocation row was wiped. Recover that live port rather
  // than re-draw one, so a running peer keeps its address.
  const runningRows = store.db
    .prepare("SELECT repo, port FROM servers WHERE ticket_id = ? AND status = 'running'")
    .all(ticketId) as { repo: string; port: number | null }[];
  const running = new Set(runningRows.map((r) => r.repo));
  const runningPort = new Map<string, number>();
  for (const row of runningRows) if (row.port !== null) runningPort.set(row.repo, row.port);

  // A dependency the ticket already declared as a BASELINE is a shared singleton
  // on its default port — allocating it an alt port would wire the target to
  // where nothing listens. Only hot peers are safe to re-draw.
  const baselineKeys = new Set(
    (
      store.db.prepare('SELECT repo FROM baseline_refs WHERE ticket_id = ?').all(ticketId) as {
        repo: string;
      }[]
    ).map((r) => r.repo),
  );

  // The target's wiring touches two groups of RUNNING units: its DEPENDENTS
  // (restart them so their env names the new target port) and the DIRECT
  // DEPENDENCIES of everything we start (whose ports their env names). Both
  // become hot and are seeded with their live port; neither is left to resolve
  // as a baseline.
  const dependents = new Set(transitiveDependents(manifest, unit.key));
  // Every unit we will START — the target plus each running dependent restarted
  // below — has its OWN peers bound into its env. Each of those peers must be
  // resolved too (recorded, live, or freshly allocated), never left to fall back
  // to a default the peer would not actually start on.
  const started = new Set<string>([unit.key]);
  for (const key of dependents) if (running.has(key)) started.add(key);
  const directDeps = new Set<string>();
  for (const key of started) {
    const startedUnit = unitByKey(manifest, key);
    if (!startedUnit) continue;
    for (const dep of startedUnit.def.dependsOn) {
      const target = resolveTarget(manifest.repositories, dep.target);
      if (!('error' in target)) directDeps.add(target.unit.key);
    }
  }
  const live = new Map<string, Map<string, number>>();
  for (const key of running) {
    if (key === unit.key) continue; // the target was stopped above
    if (!dependents.has(key) && !directDeps.has(key)) continue;
    const runningUnit = unitByKey(manifest, key);
    if (!runningUnit) continue;
    if (!hot.includes(runningUnit.repo)) hot.push(runningUnit.repo);
    const primary = primaryPortSlot(runningUnit.def);
    const port = runningPort.get(key);
    if (primary && port !== undefined && !(recorded.get(key)?.has(primary.name) ?? false)) {
      const slots = live.get(key) ?? new Map<string, number>();
      slots.set(primary.name, port);
      live.set(key, slots);
    }
  }

  // An unrecorded, STOPPED direct dependency still needs a recorded port when
  // the target's env names it — otherwise the target is wired to the peer's
  // default while the peer's own row-start would draw a different alt port. A
  // running peer keeps its live port (seeded above); a baseline peer and an
  // unrelated peer are skipped exactly as before.
  for (const key of directDeps) {
    const depUnit = unitByKey(manifest, key)!;
    const have = recorded.get(key);
    const depRecorded = depUnit.def.ports.every((p) => have?.has(p.name) ?? false);
    if (depRecorded || running.has(key) || baselineKeys.has(key)) continue;
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

  // The ports this recovery will use, resolved from three sources in order:
  //   1. the ticket's existing records — a recorded port never moves;
  //   2. a RUNNING unit's live port (its `servers` row) — the truth, even when
  //      the allocation row was wiped;
  //   3. a fresh draw for every intended unit's still-missing slot.
  // `intended` is what this recovery starts or wires: the target, its running
  // dependents, their peers, and the already-recorded peers. A hot-repository
  // unit outside it (an unrelated sibling) consumes no real port — see
  // `knownAllocator` below.
  const intended = new Set<string>([...recorded.keys(), ...started, ...directDeps]);
  const known = new Map<string, Map<string, number>>(
    [...recorded].map(([key, slots]) => [key, new Map(slots)]),
  );
  const drawn: { key: string; slot: string }[] = [];
  const insertLive = store.db.prepare(
    'INSERT OR IGNORE INTO port_allocations (ticket_id, repo, port_name, port) VALUES (?, ?, ?, ?)',
  );
  store.db.transaction(() => {
    // Steps 1+2: record every live port recovered from a running unit.
    // `INSERT OR IGNORE` guards the GLOBAL uniqueness of the port: if another
    // row already holds it, the running unit still owns it, so `known` keeps the
    // live port and `resolve` names it — we just do not duplicate the row.
    for (const [key, slots] of live) {
      const have = known.get(key) ?? new Map<string, number>();
      for (const [slot, port] of slots) {
        have.set(slot, port);
        insertLive.run(ticketId, key, slot, port);
      }
      known.set(key, have);
    }
    // Step 3: draw only an intended unit's still-missing slots. One transaction:
    // a range that exhausts mid-way records nothing.
    for (const hotUnit of unitsOfRepos(manifest, hot)) {
      if (!intended.has(hotUnit.key)) continue;
      const have = known.get(hotUnit.key) ?? new Map<string, number>();
      const missing = hotUnit.def.ports.map((p) => p.name).filter((name) => !have.has(name));
      if (missing.length === 0) continue;
      const got = fresh.allocate(
        ticketId,
        hotUnit.key,
        missing,
        hotUnit.def.portRange ?? manifest.portRange,
      );
      for (const slot of missing) {
        have.set(slot, got[slot]!);
        drawn.push({ key: hotUnit.key, slot });
      }
      known.set(hotUnit.key, have);
      opts.debug?.(
        `[runtime] ticket ${ticketId}: allocated ${missing.join(', ')} for ${hotUnit.key} (no record)`,
      );
    }
  })();

  // `resolve` needs a port for EVERY hot unit, including siblings nobody starts.
  // Serve those from the unit's DECLARED DEFAULTS: an unrelated sibling must not
  // consume a real port, nor fail the recovery by exhausting the range for the
  // units that actually matter.
  const knownAllocator: PortAllocator = {
    allocate: (_ticket, repo, slots) => {
      const have = known.get(repo);
      const out: Record<string, number> = {};
      for (const slot of slots) {
        const real = have?.get(slot);
        if (real !== undefined) {
          out[slot] = real;
          continue;
        }
        const def = unitByKey(manifest, repo)?.def.ports.find((p) => p.name === slot);
        out[slot] = def?.default ?? 0;
      }
      return out;
    },
    release: () => {
      throw new Error('knownAllocator: release() is not supported');
    },
  };
  const resolved = resolve(manifest, hot, knownAllocator, ticketId);

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
  }).catch((err: unknown) => {
    // A target that never came up must not leave its freshly drawn ports
    // recorded — a later start would play them back as if they were real.
    const dropDrawn = store.db.prepare(
      'DELETE FROM port_allocations WHERE ticket_id = ? AND repo = ? AND port_name = ?',
    );
    store.db.transaction(() => {
      for (const { key, slot } of drawn) dropDrawn.run(ticketId, key, slot);
    })();
    throw err;
  });
  opts.debug?.(
    `[runtime] ticket ${ticketId}: ${repoName} healthy (pid ${rec.pid}, new port ` +
      `${Object.values(newPorts).join(', ')})`,
  );

  // Rewire only the dependents that are RUNNING right now, in startOrder so a
  // dependent starts after anything it depends on. A stopped dependent keeps
  // its recorded port and picks it up on its next start. One dependent's failure
  // does NOT abort the rest: a dependent left pointing at the target's OLD port
  // is the silent miswiring this whole path exists to prevent, so every other
  // running dependent is still rewired. Failures are reported per service, and
  // the target stays up.
  const restartedDependents: string[] = [];
  const failures: string[] = [];
  for (const name of resolved.startOrder) {
    if (name === unit.key || !dependents.has(name) || !running.has(name)) continue;
    const depUnit = unitByKey(manifest, name)!;
    const depCwd = pathByRepo.get(depUnit.repoDef.repoPath);
    if (depCwd === undefined) {
      failures.push(`${name} (no worktree for this ticket — re-spin the ticket)`);
      continue;
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
      failures.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    restartedDependents.push(name);
    opts.debug?.(`[runtime] ticket ${ticketId}: restarted dependent ${name} for new peer port`);
  }
  if (failures.length > 0) {
    throw new StartServiceError(
      `Started ${repoName} on the new port, but could not rewire ${failures.join('; ')}.`,
    );
  }

  return { record: rec, newPorts, restartedDependents };
}
