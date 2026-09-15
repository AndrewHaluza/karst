import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { resolveBaselineBranch } from '../manifest/baselineBranch.js';
import { isRunnable } from '../manifest/runnable.js';
import { startHot, markServerStopped, type ServerRecord } from './supervisor.js';
import { serverLogPath } from './serverLog.js';
import { serviceLaunch } from './serviceLaunch.js';
import {
  attributeServer,
  systemAsyncProcessFacts,
  type ProcessFacts,
  type ProcessFactsSource,
} from './serverIdentity.js';
import { snapshotProcessFacts } from './portConflict.js';
import { baselineCheckoutDir } from './baselinePaths.js';
import { acquireBaselineStartLock, releaseBaselineStartLock } from './baselineStartLock.js';
import { worktreeRegisteredAtAsync } from './worktree.js';
import { canonicalPath, isPathUnder } from './pathScope.js';
import { runGit } from '../integrations/git.js';

/** Verbose decision-point logging, injected (`AGENTS.md` § Debug Logging Rules). */
type DebugFn = (message: string) => void;

interface RunningRow {
  id: number;
  pid: number | null;
  port: number;
  host: string;
  log_path: string;
  container: string | null;
  cwd: string | null;
  started_at: string | null;
}

/**
 * True when the live process is merely INSIDE the recorded checkout rather than
 * at its root.
 *
 * `attributeServer` compares cwd for EQUALITY, so a start command that `cd`s
 * into a subdirectory (or an app that calls `process.chdir`) reads as `foreign`
 * even though the process is ours. The checkout is baseline-owned, so a live
 * process running anywhere under it is the baseline: rescuing this is what stops
 * a shared baseline whose launcher changed directory from being retired — and
 * then killed by the port reclaim — on every dependent spin. A cwd EQUAL to the
 * root is deliberately NOT rescued: `attributeServer` only reaches its
 * start-time comparison there, and a disagreement is the reissued-pid case that
 * must retire.
 */
function cwdInsideCheckout(facts: ProcessFacts, pid: number, checkout: string | null): boolean {
  if (!checkout) return false;
  const live = facts.liveCwd(pid);
  if (!live) return false;
  return isPathUnder(live.path, checkout) && canonicalPath(live.path) !== canonicalPath(checkout);
}

/**
 * Find a running baseline singleton (NULL ticket_id) for a service, if any.
 *
 * Attributed with ASYNC probes, exactly as `stopServer` and `reclaimPort` do:
 * this runs on the extension host's spin path, and the synchronous `ps`/`lsof`
 * spawns would block the single event loop — every webview, the hook endpoint,
 * every other session — on every spin that reuses a baseline. `snapshotProcessFacts`
 * resolves each probe once, then `attributeServer` decides synchronously.
 */
async function findRunningBaseline(
  store: Store,
  service: string,
  source: ProcessFactsSource,
  debug?: DebugFn,
): Promise<ServerRecord | null> {
  const row = store.db
    .prepare(
      `SELECT id, pid, port, host, log_path, container, cwd, started_at FROM servers
       WHERE repo = ? AND ticket_id IS NULL AND status = 'running'`,
    )
    .get(service) as RunningRow | undefined;
  if (!row) return null;

  // A running row with no usable pid is a crash remnant: there is no process to
  // hand back, whatever a probe would say.
  if (row.pid == null) {
    debug?.(`[runtime] baseline ${service}: running row ${row.id} has no pid — retiring it`);
    markServerStopped(store, row.id);
    return null;
  }

  // A baseline row is retired by nothing else: the global stale-server sweep is
  // ticket-scoped (`runtime/worktreeServers.ts`) and the port reclaim refuses
  // baselines outright (`runtime/portConflict.ts`), both deliberately. So this
  // is the one place a baseline whose process is gone — or whose pid the OS has
  // since reissued — can stop being handed back to every spin as a live
  // dependency. Nothing is signalled: attribution refused precisely because the
  // pid may now be a stranger's, and `killTree` SIGKILLs a process group.
  //
  // Retire the row only on evidence it cannot be a live baseline:
  //  - `dead` (nothing runs under that pid), or
  //  - `foreign` (the pid now belongs to another process) — EXCEPT when the live
  //    process's cwd is merely a SUBDIRECTORY of the recorded checkout, which
  //    `attributeServer` reads as `foreign` only because it compares for
  //    equality (see `cwdInsideCheckout`).
  // `unknown` with a live pid STAYS: it means the platform could not answer a
  // probe — no `ps` start time on Windows, no `/proc` or `lsof` cwd — and being
  // unable to prove the process is ours is not proof that it is gone. Retiring
  // there would tear down a LIVE shared baseline on every spin the moment a
  // probe is unavailable, which is exactly the failure a shared singleton must
  // not have.
  const snapshot = await snapshotProcessFacts(source, row.pid);
  const attribution = attributeServer(
    { pid: row.pid, cwd: row.cwd, startedAt: row.started_at },
    snapshot,
  );
  const inside = attribution === 'foreign' && cwdInsideCheckout(snapshot, row.pid, row.cwd);
  if (attribution === 'dead' || (attribution === 'foreign' && !inside)) {
    debug?.(
      `[runtime] baseline ${service}: row ${row.id} (pid ${row.pid}) is '${attribution}' — retiring, starting fresh`,
    );
    markServerStopped(store, row.id);
    return null;
  }
  // A running row whose checkout was removed out from under it (a hand-run `git
  // worktree remove`, an `rm -rf`) would otherwise be handed back forever,
  // serving a deleted tree: the process still attributes on Linux (the path
  // canonicalizes equal, the `deleted` flag is not consulted) and nothing else
  // reaps a baseline. Retire it so the caller recuts.
  if (row.cwd && !existsSync(row.cwd)) {
    debug?.(`[runtime] baseline ${service}: checkout ${row.cwd} is gone — retiring row ${row.id}`);
    markServerStopped(store, row.id);
    return null;
  }
  debug?.(
    `[runtime] baseline ${service}: reusing row ${row.id} (pid ${row.pid}, attribution '${attribution}')`,
  );

  return {
    id: row.id,
    ticketId: null,
    service,
    host: row.host,
    port: row.port,
    pid: row.pid,
    status: 'running',
    logPath: row.log_path,
    container: row.container,
  };
}

/**
 * The commit a baseline worktree is cut from: `origin/<branch>` when that
 * remote-tracking ref resolves, else the LOCAL `<branch>`. A repository with no
 * `origin` (or a branch never pushed) must still get a baseline — falling back
 * to the local branch serves the same commit the old attached checkout did, and
 * only leaves it stale-looking when no remote exists to be fresher.
 */
async function resolveBaselineRef(repoPath: string, branch: string): Promise<string> {
  const remoteRef = `origin/${branch}`;
  const r = await runGit(['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`], repoPath);
  return r.exitCode === 0 && r.stdout.trim() !== '' ? remoteRef : branch;
}

/**
 * Ensure the baseline checkout EXISTS and is registered, and report the commit
 * it should serve. Does NOT move an existing, valid directory — the destructive
 * refresh is `refreshBaselineCheckout`, and it runs only after liveness is
 * re-checked, because the fetch below is a long await during which another
 * window can have started serving this very directory (see `startBaseline`).
 *
 * DETACHED at `origin/<branch>`, not attached to the local branch. Attaching it
 * takes the base branch out of circulation for the whole repository: `pullBase.ts`
 * prefers `git fetch origin <base>:<base>` to fast-forward the local branch
 * without a checkout, and git refuses that while the branch is checked out
 * anywhere — so an attached baseline silently degrades every ticket scope in
 * that repo to the `origin/<base>` fallback. Detached costs nothing here: the
 * baseline serves code, it never commits.
 *
 * Validated, not merely present: `existsSync` alone adopts a directory git no
 * longer knows about (a pruned worktree, a hand-recreated folder), and serving
 * from that is serving from nothing knowable. An invalid directory is removed
 * and recut — a baseline checkout holds no user work, so this is always safe.
 *
 * EVERY subprocess here is the ASYNC, bounded `runGit`, never `spawnSync`. The
 * fetch touches the network, the checkout/removal can be large, and the
 * registration check spawns git too — and this runs on the extension host, where
 * any synchronous spawn would freeze the single event loop: every webview, the
 * hook endpoint, every session. Even the registration check therefore goes
 * through `worktreeRegisteredAtAsync` (`runtime/worktree.ts`), not the legacy
 * synchronous `worktreeRegisteredAt`.
 */
async function ensureBaselineCheckout(
  repoPath: string,
  service: string,
  branch: string,
  debug?: DebugFn,
): Promise<{ dir: string; created: boolean; startRef: string }> {
  const dir = baselineCheckoutDir(repoPath, service);

  if (existsSync(dir) && !(await worktreeRegisteredAtAsync(repoPath, dir))) {
    debug?.(`[runtime] baseline ${service}: ${dir} is not a registered worktree — recutting`);
    // Status deliberately ignored: git does not know this path, so the remove
    // will fail. The `rm` is what actually clears it; the call is here only to
    // retire any administrative entry git does still hold.
    await runGit(['worktree', 'remove', '--force', dir], repoPath);
    await rm(dir, { recursive: true, force: true });
  }

  // Best-effort refresh of the remote-tracking ref, off the event loop. Offline
  // is not an error: a failure leaves whatever `origin/<branch>` already points
  // at, and `resolveBaselineRef` falls back to the local branch when even that
  // is absent.
  await runGit(['fetch', 'origin', branch], repoPath);

  const startRef = await resolveBaselineRef(repoPath, branch);

  if (!existsSync(dir)) {
    debug?.(`[runtime] baseline ${service}: creating detached checkout at ${dir} (${startRef})`);
    const r = await runGit(
      ['worktree', 'add', '-q', '--detach', '--force', dir, startRef],
      repoPath,
    );
    if (r.exitCode !== 0) {
      throw new Error(`failed to create baseline checkout for ${service}: ${r.stderr}`);
    }
    return { dir, created: true, startRef };
  }
  return { dir, created: false, startRef };
}

/**
 * Move an existing checkout to the freshly fetched tip.
 *
 * Destructive (`--force` rewrites tracked files), so the caller must hold the
 * cross-process start lock (`baselineStartLock.ts`) and have re-checked that no
 * live baseline row exists: nothing else can then be serving this directory.
 * `--detach` keeps the local branch free even for a checkout created attached by
 * an older build.
 */
async function refreshBaselineCheckout(
  dir: string,
  service: string,
  startRef: string,
  debug?: DebugFn,
): Promise<void> {
  debug?.(`[runtime] baseline ${service}: refreshing checkout at ${dir} to ${startRef}`);
  const r = await runGit(['checkout', '--detach', '--force', startRef], dir);
  if (r.exitCode !== 0) {
    throw new Error(`failed to refresh baseline checkout for ${service}: ${r.stderr}`);
  }
}

export interface EnsureBaselineOpts {
  /**
   * OS probes, injected so tests never depend on this machine's processes. Both
   * the synchronous `ProcessFacts` and the async `ProcessFactsSource` are
   * accepted; the default is `systemAsyncProcessFacts`, because this runs on the
   * extension host's spin path where a `spawnSync` would block the event loop.
   */
  facts?: ProcessFactsSource;
  /**
   * Verbose decision-point logging, prefixed `[runtime]`. Absent → silent; the
   * host binds it to `Logger.debug` (a no-op unless the manifest's `debug` flag
   * is on).
   */
  debug?: DebugFn;
  /**
   * How long this spin waits for ANOTHER WINDOW's in-flight start of the same
   * baseline before giving up. Two windows on one repository share `repoPath`,
   * so a concurrent spin is ordinary: the shared singleton is honoured by
   * ADOPTING the row the other window publishes at its health gate, and this
   * budget only bounds a start that never publishes one (a crash, a hung fetch).
   */
  lockWaitMs?: number;
  /** Sleep hook for the cross-window wait; tests inject an instant resolver. */
  sleep?: (ms: number) => Promise<void>;
}

/** How long to wait for another window's baseline start to publish a running row. */
const START_LOCK_WAIT_MS = 90_000;
/** How often the cross-window wait re-polls for the other window's row or lock. */
const START_LOCK_POLL_MS = 500;

/**
 * Baseline starts in flight in THIS window, keyed by repo path and service.
 *
 * Two spins that need the same baseline both find no running row and both start
 * one; the second then reclaims the port from the first (or, with the guard in
 * `runtime/portConflict.ts`, fails outright). Sharing the first start's promise
 * makes the second spin wait for it and reuse the result, which is what the
 * "lazy singleton" in the design has always meant.
 *
 * Window-scoped only. A collision across two IDE windows is serialised instead
 * by the cross-process start lock (`baselineStartLock.ts`): the second window
 * waits for the first and ADOPTS the row it publishes, rather than starting a
 * rival or refreshing the checkout out from under it (`startBaseline`).
 */
const inFlight = new Map<string, Promise<ServerRecord>>();

/**
 * Acquire-if-not-running / reuse-if-running (§9). A baseline service is a lazy
 * singleton on its default port, served from `baselineBranch`, health-gated.
 * Never ticket-killed in MVP — lives with the daemon.
 */
export async function ensureBaseline(
  store: Store,
  manifest: Manifest,
  service: string,
  opts: EnsureBaselineOpts = {},
): Promise<ServerRecord> {
  const facts = opts.facts ?? systemAsyncProcessFacts;
  const debug = opts.debug;
  const existing = await findRunningBaseline(store, service, facts, debug);
  if (existing) return existing;

  const repo = manifest.repositories[service];
  if (!repo) throw new Error(`repository "${service}" not in manifest`);
  const key = JSON.stringify([repo.repoPath, service]);
  const running = inFlight.get(key);
  if (running) {
    debug?.(`[runtime] baseline ${service}: sharing the in-flight start already underway in this window`);
    return running;
  }

  const started = startBaseline(store, manifest, service, facts, debug, {
    lockWaitMs: opts.lockWaitMs,
    sleep: opts.sleep,
  }).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

interface BaselineWait {
  lockWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

async function startBaseline(
  store: Store,
  manifest: Manifest,
  service: string,
  facts: ProcessFactsSource,
  debug?: DebugFn,
  wait: BaselineWait = {},
): Promise<ServerRecord> {
  const repo = manifest.repositories[service];
  if (!repo) throw new Error(`repository "${service}" not in manifest`);
  // Reachable only via a dependsOn edge, and `validateGraph` rejects an edge to a
  // non-runnable target — so this is a defensive throw, not a user-facing path.
  // It exists because the alternative (the old code) fabricated
  // `http://host:undefined/health` and health-gated against it.
  if (!isRunnable(repo)) {
    throw new Error(`repository "${service}" declares no service and cannot run as a baseline`);
  }
  const svc = repo.service;

  const httpSlot = svc.ports.find((p) => p.name === 'http') ?? svc.ports[0]!;
  const port = httpSlot.default;

  // Serialise STARTS across processes. `inFlight` covers one window only, while
  // the `servers` table is shared, and a baseline's row is written only after
  // its health gate — so without this a second window cannot tell a baseline
  // that is mid-start from one whose window died before writing a row: it would
  // force-refresh the first's checkout, or refuse to reap the second forever.
  // Held for the whole start (fetch, checkout, spawn, health gate).
  //
  // Losing the race is NOT an error. Two windows on the same repository are the
  // ordinary case, and the singleton is shared: wait for the other window to
  // publish its health-gated row and ADOPT it. Only a start that never publishes
  // one (a crash mid-start, a hung fetch) exhausts the budget; taking over its
  // released lock (or its stale one) resumes the work here.
  const lockWaitMs = wait.lockWaitMs ?? START_LOCK_WAIT_MS;
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + lockWaitMs;
  let acquired = acquireBaselineStartLock(repo.repoPath, service);
  while (!acquired) {
    const other = await findRunningBaseline(store, service, facts, debug);
    if (other) {
      debug?.(
        `[runtime] baseline ${service}: another window finished its start — adopting row ${other.id}`,
      );
      return other;
    }
    if (Date.now() >= deadline) {
      debug?.(
        `[runtime] baseline ${service}: another window still holds the start lock after ${lockWaitMs}ms — giving up`,
      );
      throw new Error(`baseline "${service}" is already starting in another window`);
    }
    await sleep(Math.min(START_LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
    acquired = acquireBaselineStartLock(repo.repoPath, service);
  }
  try {
    // Re-check after taking the lock: the other window may have finished its
    // start (traceable row) or we may have raced its health-gated row write.
    const raced = await findRunningBaseline(store, service, facts, debug);
    if (raced) return raced;

    const { dir: checkout, created, startRef } = await ensureBaselineCheckout(
      repo.repoPath,
      service,
      resolveBaselineBranch(manifest, repo),
      debug,
    );
    // Safe to rewrite: we hold the lock (no other window is starting) and the
    // re-check above proved no live baseline row exists for this checkout.
    if (!created) await refreshBaselineCheckout(checkout, service, startRef, debug);

    const env = { [httpSlot.env]: String(port) };
    // A baseline runs whatever kind of service the manifest declares — a command
    // or a container — through the same derivation spin uses, so the singleton can
    // never end up started one way and reaped another.
    const { command, args, container, healthUrl } = serviceLaunch({
      service: svc,
      name: service,
      ticketId: null,
      env,
      host: manifest.host,
      port,
      cwd: checkout,
    });

    debug?.(`[runtime] baseline ${service}: starting on ${manifest.host}:${port} from ${checkout}`);
    return await startHot(store, {
      ticketId: null, // baseline singleton
      service,
      command,
      args,
      container,
      cwd: checkout,
      env,
      host: manifest.host,
      port,
      healthUrl,
      requireIdentity: svc.healthIdentity === true,
      logPath: serverLogPath(checkout, `${service}.baseline`),
      repoPath: repo.repoPath,
    });
  } finally {
    releaseBaselineStartLock(repo.repoPath, service);
  }
}

/**
 * Record a ref edge: this ticket depends on the baseline `service` (§9 ledger).
 * Informs "who'd be affected if you stopped this baseline". Idempotent (PK on
 * ticket+service).
 */
export function addBaselineRef(store: Store, ticketId: number, service: string): void {
  store.db
    .prepare(
      'INSERT OR IGNORE INTO baseline_refs (ticket_id, repo) VALUES (?, ?)',
    )
    .run(ticketId, service);
}
