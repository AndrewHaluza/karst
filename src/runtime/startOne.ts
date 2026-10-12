import type { Store } from '../store/db.js';
import type { Manifest, PortSlot, ServiceDef } from '../manifest/types.js';
import {
  unitByKey,
  unitsOfRepos,
  resolveTarget,
  serviceUnits,
  type ServiceUnit,
} from '../manifest/runnable.js';
import { resolve, transitiveDependents } from '../resolver/resolve.js';
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
 * cannot reclaim), the target is started on them, and everything the moved ports
 * TOUCH is recovered with it: every RUNNING unit that DIRECTLY consumes a moved
 * port (the target's dependents, and any other consumer of a re-drawn
 * dependency) is restarted in `startOrder` so its env carries the new URL, and a
 * RUNNING peer contributes its LIVE port (recovered from its `servers` row)
 * rather than being re-drawn. A unit that consumes no moved port is left alone. A recorded port never moves; a stopped, non-baseline dependency is
 * allocated a port so its consumers' env names a recorded one (a declared
 * baseline keeps its shared default). A stopped unit stays stopped — its next
 * start reads the recorded port. Starting a RECORDED unit is unaffected: a hot
 * sibling with no record is served its declared default, never a re-spin error.
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
   * Unit keys of the RUNNING units restarted because a port they depended on
   * moved, in `startOrder`. Empty on the recorded path.
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

/**
 * The `resolve` allocator for a fixed port map: a unit's known port when there
 * is one, its DECLARED DEFAULT otherwise. `resolve` is repository-scoped, so a
 * hot repository can contain a unit this operation neither starts nor wires — a
 * sibling added to the manifest after the spin, or an unrelated unit of the
 * target's repository. Such a unit must not fail the resolve (the missing-
 * allocation error this path exists to remove) nor consume a real port.
 */
function makeKnownAllocator(
  manifest: Manifest,
  known: ReadonlyMap<string, ReadonlyMap<string, number>>,
): PortAllocator {
  return {
    allocate: (_ticketId, repo, slots) => {
      const have = known.get(repo);
      const out: Record<string, number> = {};
      for (const slot of slots) {
        out[slot] =
          have?.get(slot) ??
          unitByKey(manifest, repo)?.def.ports.find((p) => p.name === slot)?.default ??
          0;
      }
      return out;
    },
    release: () => {
      throw new Error('makeKnownAllocator: release() is not supported');
    },
  };
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
    // Recorded path: playback of the ticket's recorded ports — no port moves, no
    // dependent restarts. `resolve` is repository-scoped, so a hot sibling with
    // NO record (a service added to the manifest after the spin) is served its
    // declared default rather than throwing the re-spin error when the user
    // starts a RECORDED sibling.
    const known = new Map<string, Map<string, number>>(
      [...recorded].map(([key, slots]) => [key, new Map(slots)]),
    );
    const resolved = resolve(manifest, hot, makeKnownAllocator(manifest, known), ticketId);
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

  // What this recovery must START and WIRE, to a fixed point:
  //  - a unit is STARTED if it is the target, or a RUNNING unit that depends on
  //    something whose port MOVES (a stopped, unrecorded unit is drawn fresh);
  //  - a unit is WIRED if a started unit depends on it (its port goes into the
  //    env), whether or not it is running.
  // Moving a port pulls in its own running dependents, whose peers are then
  // wired too — so a shared stopped dependency's OTHER running consumer is
  // rewired alongside the target, never left on the old port.
  const directDepUnits = (key: string): ServiceUnit[] => {
    const u = unitByKey(manifest, key);
    if (!u) return [];
    const deps: ServiceUnit[] = [];
    for (const dep of u.def.dependsOn) {
      // An edge with no `bind` puts no peer port into env, so its target is
      // neither wired nor needs a port drawn for it.
      if (dep.bind.length === 0) continue;
      const target = resolveTarget(manifest.repositories, dep.target);
      if (!('error' in target)) deps.push(target.unit);
    }
    return deps;
  };
  const fullyRecorded = (u: ServiceUnit): boolean => {
    const have = recorded.get(u.key);
    return u.def.ports.every((p) => have?.has(p.name) ?? false);
  };
  /** Every unit with a BOUND dependsOn edge to `key` — the consumers of its port. */
  const directDependents = (key: string): string[] => {
    const out: string[] = [];
    for (const u of serviceUnits(manifest)) {
      if (u.key === key) continue;
      for (const dep of u.def.dependsOn) {
        if (dep.bind.length === 0) continue;
        const target = resolveTarget(manifest.repositories, dep.target);
        if (!('error' in target) && target.unit.key === key) {
          out.push(u.key);
          break;
        }
      }
    }
    return out;
  };

  // The units this recovery WIRES and STARTS, to a fixed point.
  //
  //  - `started` is the target plus every RUNNING transitive dependent of it —
  //    a moved target port is named all the way downstream, so their envs must
  //    be resolved.
  //  - `wire` is every BOUND peer of a started unit, so a started unit's env is
  //    fully resolved.
  //  - A unit whose port MOVES — the target, or any intended stopped/unrecorded
  //    unit (it is drawn fresh) — pulls in the RUNNING units that DIRECTLY
  //    consume it.
  //
  // Starting a unit does NOT by itself restart its dependents: the actual
  // restarts below are filtered to units that consume a moved port.
  let started = new Set<string>([unit.key]);
  for (const key of transitiveDependents(manifest, unit.key)) {
    if (running.has(key)) started.add(key);
  }
  let wire = new Set<string>();
  const movedPorts = (startedKeys: Set<string>, wireKeys: Set<string>): Set<string> => {
    const moved = new Set<string>([unit.key]);
    for (const key of [...startedKeys, ...wireKeys]) {
      const u = unitByKey(manifest, key);
      if (u && !running.has(key) && !fullyRecorded(u)) moved.add(key);
    }
    return moved;
  };
  for (;;) {
    wire = new Set<string>();
    for (const key of started) {
      for (const dep of directDepUnits(key)) {
        if (!baselineKeys.has(dep.key)) wire.add(dep.key);
      }
    }
    const next = new Set(started);
    for (const movedKey of movedPorts(started, wire)) {
      for (const v of directDependents(movedKey)) if (running.has(v)) next.add(v);
    }
    if (next.size === started.size) break;
    started = next;
  }
  const moved = movedPorts(started, wire);

  // Every started/wired repository is hot. A RUNNING started/wired unit has its
  // live port recovered from its `servers` row rather than re-drawn.
  const live = new Map<string, Map<string, number>>();
  for (const key of [...started, ...wire]) {
    const u = unitByKey(manifest, key);
    if (!u) continue;
    if (!hot.includes(u.repo)) hot.push(u.repo);
    if (!running.has(key)) continue;
    const primary = primaryPortSlot(u.def);
    const port = runningPort.get(key);
    if (primary && port !== undefined && !(recorded.get(key)?.has(primary.name) ?? false)) {
      const slots = live.get(key) ?? new Map<string, number>();
      slots.set(primary.name, port);
      live.set(key, slots);
    }
  }

  const probe =
    opts.probeBusyPorts ??
    ((host, ranges, repoPaths) => portsToAvoid(store, host, ranges, repoPaths, { debug: opts.debug }));
  const busy = await probe(
    manifest.host,
    allocationRanges(manifest, hot),
    hotRepoPaths(manifest, hot),
  );
  // A RUNNING unit is listening on its live port right now — including a
  // same-repository sibling this recovery does NOT restart. The probe may call
  // that port reclaimable (it is a karst server), so reserve every running
  // unit's live port explicitly: a fresh draw must never land on one.
  const avoid = new Set(busy);
  for (const port of runningPort.values()) avoid.add(port);
  if (avoid.size > 0) {
    opts.debug?.(
      `[runtime] ticket ${ticketId}: ${avoid.size} occupied/live port(s) excluded from recovery allocation`,
    );
  }
  const fresh = makePortAllocator(store, manifest.portRange, { busy: avoid });

  // The ports this recovery will use, resolved from three sources in order:
  //   1. the ticket's existing records — a recorded port never moves;
  //   2. a RUNNING unit's live port (its `servers` row) — the truth, even when
  //      the allocation row was wiped;
  //   3. a fresh draw for every intended unit's still-missing slot.
  // `intended` is what this recovery starts or wires, together with the peers
  // whose ports are already recorded. A hot-repository unit outside it (an
  // unrelated sibling) consumes no real port — see `makeKnownAllocator`.
  const intended = new Set<string>([...recorded.keys(), ...started, ...wire]);
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

  // `resolve` needs a port for EVERY hot unit, including siblings nobody starts;
  // `makeKnownAllocator` serves those their declared defaults, so an unrelated
  // sibling neither consumes a real port nor fails the recovery by exhausting
  // the range for the units that actually matter.
  const resolved = resolve(manifest, hot, makeKnownAllocator(manifest, known), ticketId);

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

  // Restart only the started units that CONSUME a moved port, in startOrder so a
  // unit starts after anything it depends on. A unit that consumes no moved port
  // (its peers kept their addresses) is left running untouched. One failure does
  // NOT abort the rest: a unit left pointing at an OLD port is the silent
  // miswiring this whole path exists to prevent, so every other affected unit is
  // still rewired. Failures are reported per service, and the target stays up.
  const restartedDependents: string[] = [];
  const failures: string[] = [];
  for (const name of resolved.startOrder) {
    if (name === unit.key || !started.has(name) || !running.has(name)) continue;
    if (!directDepUnits(name).some((dep) => moved.has(dep.key))) continue;
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
