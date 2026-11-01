import { existsSync } from 'node:fs';
import { killTree, type KillOutcome } from './processTree.js';
import {
  attributeServer,
  type ProcessFacts,
  type ProcessFactsSource,
  type ServerIdentity,
  systemAsyncProcessFacts,
} from './serverIdentity.js';
import { buildInventory, type Inventory, type KnownPid } from './resourceInventory.js';
import { findWaste, type DirectoryProbe, type WasteFinding } from './wasteFindings.js';
import { readProcSnapshot, type ProcSnapshot } from './procSnapshot.js';
import { listRunningServers, listTicketLifecycle } from '../store/runningServers.js';
import { markServerStopped } from './supervisor.js';
import type { Store } from '../store/db.js';
import type { LogError } from '../logging/logger.js';
import { getCpuCoreCount } from './cpuCores.js';
import type { SbxProcess } from '../agent/sbx/sbxProcess.js';
import { sampleContainers, type ContainerStat } from './containerSampler.js';
import { applyContainers, vmProcessCost } from './containerRows.js';
import type { VmOverhead } from './resourceInventory.js';
import type { RunningServerRow } from '../store/runningServers.js';

/**
 * The single host-agnostic object that owns the two sampling lanes, the ring
 * buffer, the live pid registry, and the kill path. Everything above it is
 * pure; everything below it is `vscode` (injected through `ResourceMonitorDeps`).
 *
 * - A **slow lane** every 30 s for the lifetime of the window.
 * - A **fast lane** every 2 s ONLY while the Resources panel is visible.
 * - Each tick is ONE `ps` child process. CPU% is derived from the DELTA of
 *   cumulative CPU seconds between consecutive samples — never `ps %cpu`.
 * - Each tick is single-flight: if the previous `ps` has not settled, the tick
 *   is skipped and counted, never queued.
 * - The WHOLE tick body is guarded: a monitoring defect reaches `logError` and
 *   the previous reading is retained. A monitoring defect may never break the
 *   window.
 */
export const SLOW_LANE_INTERVAL_MS = 30_000;
export const FAST_LANE_INTERVAL_MS = 2_000;
export const RING_CAPACITY = 150;
/** A container reading older than this (3 slow ticks) is dropped rather than shown as current. */
export const CONTAINER_STALE_MS = 3 * SLOW_LANE_INTERVAL_MS;

export interface ResourceSample {
  takenMs: number;
  totals: { rssBytes: number; cpuPct: number | null };
}

export interface ResourceReading {
  supported: boolean;
  /** True when the last tick's `ps` did not answer. */
  degraded: boolean;
  inventory: Inventory | null;
  waste: WasteFinding[];
  history: readonly ResourceSample[];
  /** Ticks skipped because the previous `ps` was still in flight. */
  skipped: number;
  /** Whether the fast lane is live right now (panel visible). */
  fastLane: boolean;
  /** True when the last container sample failed (daemon down / timeout); the previous reading is kept. */
  containersDegraded?: boolean;
}

export interface ResourceMonitorDeps {
  store: Store;
  projectId: () => number | undefined;
  /** Roots under which a process counts as inside a karst worktree. */
  worktreeRoots: () => string[];
  facts?: ProcessFactsSource;
  dirs?: DirectoryProbe;
  now?: () => number;
  readSnapshot?: typeof readProcSnapshot;
  debug?: (message: string) => void;
  logError?: LogError;
  cpuCoreCount?: number;
  /** Docker seam for the container sampler; with `projectRoot`, enables it. */
  docker?: SbxProcess;
  projectRoot?: () => string | undefined;
}

const noop = (): void => {};

export class ResourceMonitor {
  private readonly store: Store;
  private readonly projectId: () => number | undefined;
  private readonly worktreeRoots: () => string[];
  private readonly facts: ProcessFactsSource;
  private readonly dirs: DirectoryProbe;
  private readonly now: () => number;
  private readonly readSnapshot: typeof readProcSnapshot;
  private readonly debug: (message: string) => void;
  private readonly logError: LogError;
  private readonly cpuCoreCount: number;
  private readonly docker: SbxProcess | undefined;
  private readonly projectRoot: () => string | undefined;

  private slowTimer: ReturnType<typeof setInterval> | undefined;
  private fastTimer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private skipped = 0;
  private disposed = false;
  private supported = true;
  private degraded = false;
  private previous: ProcSnapshot | null = null;
  private history: ResourceSample[] = [];
  private inventory: Inventory | null = null;
  private waste: WasteFinding[] = [];
  private baseInventory: Inventory | null = null;
  private servers: RunningServerRow[] = [];
  private vm: VmOverhead | null = null;
  private containerStats: ContainerStat[] | null = null;
  private containersDegraded = false;
  private containersOkMs = 0;
  private sampling = false;
  private readonly registry = new Map<number, KnownPid>();
  private readonly listeners = new Set<(reading: ResourceReading) => void>();

  constructor(deps: ResourceMonitorDeps) {
    this.store = deps.store;
    this.projectId = deps.projectId;
    this.worktreeRoots = deps.worktreeRoots;
    this.facts = deps.facts ?? systemAsyncProcessFacts;
    this.dirs = deps.dirs ?? { exists: existsSync };
    this.now = deps.now ?? Date.now;
    this.readSnapshot = deps.readSnapshot ?? readProcSnapshot;
    this.debug = deps.debug ?? noop;
    this.logError = deps.logError ?? noop;
    this.cpuCoreCount = deps.cpuCoreCount ?? getCpuCoreCount();
    this.docker = deps.docker;
    this.projectRoot = deps.projectRoot ?? (() => undefined);
  }

  /**
   * Register a live non-server pid (agent, gate, session) and return a disposer
   * that removes it. Server pids are NOT registered here — they are read from
   * the store every tick, because a server outlives the call that started it.
   */
  registerPid(entry: KnownPid): () => void {
    if (entry.pid == null || !Number.isInteger(entry.pid) || entry.pid <= 0) return noop;
    this.registry.set(entry.pid, entry);
    return () => {
      this.registry.delete(entry.pid);
    };
  }

  start(): void {
    if (this.slowTimer !== undefined || !this.supported) return;
    this.slowTimer = setInterval(() => {
      void this.tick(true);
    }, SLOW_LANE_INTERVAL_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.clearLanes();
    this.listeners.clear();
  }

  setPanelVisible(visible: boolean): void {
    if (!this.supported) return;
    if (visible) {
      if (this.fastTimer === undefined) {
        this.fastTimer = setInterval(() => {
          void this.tick(false);
        }, FAST_LANE_INTERVAL_MS);
      }
    } else if (this.fastTimer !== undefined) {
      clearInterval(this.fastTimer);
      this.fastTimer = undefined;
    }
  }

  onReading(listener: (reading: ResourceReading) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reading(): ResourceReading {
    return {
      supported: this.supported,
      degraded: this.degraded,
      inventory: this.inventory,
      waste: this.waste,
      history: [...this.history],
      skipped: this.skipped,
      fastLane: this.fastTimer !== undefined,
      containersDegraded: this.containersDegraded,
    };
  }

  /** Force one slow-lane tick (used on panel open, so the panel is not blank for up to 30 s). */
  async refreshNow(): Promise<void> {
    await this.tick(true);
  }

  /**
   * The ONLY mutating method. Re-reads the `servers` row, re-resolves
   * attribution with FRESH async probes (a sample can be up to 30 s old, and a
   * stale sample must never signal a reissued pid), and only then signals.
   * A `'denied'` or `'not-attributable'` result never touches the row.
   */
  async kill(serverId: number): Promise<KillOutcome | 'not-attributable'> {
    const row = listRunningServers(this.store, this.projectId()).find((r) => r.id === serverId);
    if (!row || row.pid === null) return 'not-attributable';
    const identity: ServerIdentity = { pid: row.pid, cwd: row.cwd, startedAt: row.startedAt };
    const [alive, live, started] = await Promise.all([
      this.facts.isAlive(row.pid),
      this.facts.liveCwd(row.pid),
      this.facts.processStartMs(row.pid),
    ]);
    const resolved: ProcessFacts = {
      isAlive: () => alive,
      liveCwd: () => live,
      processStartMs: () => started,
    };
    if (attributeServer(identity, resolved) !== 'attributable') return 'not-attributable';
    const outcome = killTree(row.pid);
    if (outcome === 'killed') markServerStopped(this.store, serverId);
    return outcome;
  }

  private clearLanes(): void {
    if (this.slowTimer !== undefined) {
      clearInterval(this.slowTimer);
      this.slowTimer = undefined;
    }
    if (this.fastTimer !== undefined) {
      clearInterval(this.fastTimer);
      this.fastTimer = undefined;
    }
  }

  private notify(): void {
    if (this.disposed) return;
    const reading = this.reading();
    for (const listener of this.listeners) {
      try {
        listener(reading);
      } catch (err) {
        this.logError('a resource monitor listener threw', err);
      }
    }
  }

  private async tick(confirmCwd: boolean): Promise<void> {
    if (this.disposed || !this.supported) return;
    if (this.ticking) {
      this.skipped += 1;
      this.debug(`[resources] tick skipped (${this.skipped} in flight)`);
      return;
    }
    this.ticking = true;
    this.debug(
      `[resources] tick start (${confirmCwd ? 'slow' : 'fast'} lane, ${this.skipped} skipped so far)`,
    );
    try {
      const result = await this.readSnapshot(this.now, process.platform);
      if (!result.supported) {
        this.supported = false;
        this.degraded = false;
        this.clearLanes();
        this.debug('[resources] tick: platform unsupported — lanes stopped');
        this.notify();
        return;
      }
      if (result.snapshot === null) {
        this.degraded = true;
        this.debug('[resources] tick: ps did not answer — keeping the previous reading');
        this.notify();
        return;
      }
      this.degraded = false;
      const snapshot = result.snapshot;

      const known: KnownPid[] = [];
      const servers = listRunningServers(this.store, this.projectId());
      for (const row of servers) {
        if (row.pid === null) continue;
        known.push({
          pid: row.pid,
          kind: 'server',
          ticketId: row.ticketId,
          label: row.repo,
          identity: { pid: row.pid, cwd: row.cwd, startedAt: row.startedAt },
          serverId: row.id,
        });
      }
      for (const entry of this.registry.values()) known.push(entry);

      const inventory = await buildInventory({
        snapshot,
        previous: this.previous,
        known,
        facts: this.facts,
        confirmCwd,
        cpuCoreCount: this.cpuCoreCount,
        debug: this.debug,
      });

      this.baseInventory = inventory;
      this.servers = servers;
      this.vm = vmProcessCost(snapshot, this.previous, this.cpuCoreCount);
      this.compose();
      this.history.push({ takenMs: snapshot.takenMs, totals: this.inventory!.totals });
      if (this.history.length > RING_CAPACITY) this.history.shift();
      this.previous = snapshot;
      this.debug(
        `[resources] tick: ${this.inventory!.attributed.length} attributed, ${this.waste.length} waste findings`,
      );
      this.notify();
      // Slow lane only: `docker stats` takes ~2 s, so it never rides the fast tick,
      // and it is never awaited here — a slow daemon must not hold a tick.
      if (confirmCwd) void this.refreshContainers();
    } catch (err) {
      this.logError('resource monitor tick failed', err);
    } finally {
      this.ticking = false;
    }
  }

  /** Fold the base inventory, the last container reading and the VM cost into the published reading. */
  private compose(): void {
    if (this.baseInventory === null) return;
    const root = this.projectRoot();
    const inventory =
      root === undefined
        ? this.baseInventory
        : applyContainers({
            inventory: this.baseInventory,
            stats: this.containerStats,
            servers: this.servers,
            projectRoot: root,
            vm: this.vm,
          });
    const ticketIds = [
      ...new Set(
        [...this.servers.map((s) => s.ticketId), ...inventory.attributed.map((r) => r.ticketId)].filter(
          (id): id is number => id !== null,
        ),
      ),
    ];
    this.inventory = inventory;
    this.waste = findWaste({
      inventory,
      servers: this.servers,
      lifecycle: listTicketLifecycle(this.store, ticketIds),
      worktreeRoots: this.worktreeRoots(),
      dirs: this.dirs,
    });
  }

  /** Single-flight, bounded container sample. A failure keeps the previous reading. Never throws. */
  async refreshContainers(): Promise<void> {
    const root = this.projectRoot();
    if (this.disposed || this.sampling || this.docker === undefined || root === undefined) return;
    this.sampling = true;
    try {
      const sample = await sampleContainers({
        docker: this.docker,
        projectRoot: root,
        serverContainers: this.servers.map((s) => s.container).filter((c): c is string => !!c),
        cpuCoreCount: this.cpuCoreCount,
      });
      if (sample.ok) {
        this.containerStats = sample.stats;
        this.containersOkMs = this.now();
        this.containersDegraded = false;
      } else if (sample.reason === 'no-docker') {
        // Not installed is a state, not a failure: no banner, no stale rows.
        this.containerStats = null;
        this.containersDegraded = false;
      } else {
        if (this.now() - this.containersOkMs > CONTAINER_STALE_MS) this.containerStats = null;
        this.containersDegraded = true;
        this.debug(`[resources] container sample failed (${sample.reason}) — keeping the previous reading`);
      }
      this.compose();
      this.notify();
    } catch (err) {
      this.logError('resource monitor container sample failed', err);
    } finally {
      this.sampling = false;
    }
  }
}
