import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, readFileSync, existsSync, mkdirSync, statSync, readSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from '../store/db.js';
import {
  waitForHealth,
  HealthAbortedError,
  HealthTimeoutError,
  INSTANCE_ENV,
} from './health.js';
import { killTree } from './processTree.js';
import { prepareCommand, type ShimEnv } from './command.js';
import { resolveCommandCwd } from './commandCwd.js';
import { isPortOpen, reclaimPort, listenerPids, snapshotProcessFacts } from './portConflict.js';
import { removeContainer, removeContainerAsync } from './dockerContainer.js';
import { attributeServer, systemAsyncProcessFacts, type ProcessFactsSource } from './serverIdentity.js';
import { runMarkerLine } from './serverLog.js';
export { killTree } from './processTree.js';

/**
 * SIGKILL a process AND its descendants. Children are spawned `detached`, making
 * the child the leader of its own process group whose id equals its pid; killing
 * the negative pid reaps the whole group — critical for launchers like `npm run
 * dev` that fork a grandchild (Vite) which a plain `child.kill()` would orphan.
 * Falls back to a direct kill if the group signal fails, and swallows ESRCH
 * (already gone). Never throws.
 */
export interface ServerRecord {
  id: number;
  ticketId: number | null;
  service: string;
  host: string;
  port: number;
  pid: number;
  status: 'running' | 'stopped' | 'failed';
  logPath: string;
  /** The docker container this service runs in, or null for a plain command. */
  container: string | null;
}

/**
 * Record a service that FAILED to start, so the dashboard can show it (red,
 * not merely absent) and its logs button can find `logPath`. Without this a
 * spin that dies before the health-gated INSERT below leaves no row at all —
 * the failure is real and explained in the thrown error, but nothing
 * downstream (dashboard state, the servers panel, the logs viewer) can ever
 * learn it happened. Same single-row-per-(ticket,service) replace as the
 * success path, so a retry's failed row doesn't accumulate duplicates either.
 */
function recordFailedStart(
  store: Store,
  opts: Pick<StartHotOpts, 'ticketId' | 'service' | 'host' | 'port' | 'logPath' | 'cwd' | 'container'>,
): void {
  const spawnedAt = new Date().toISOString();
  store.db
    .prepare('DELETE FROM servers WHERE repo = ? AND ticket_id IS ?')
    .run(opts.service, opts.ticketId);
  store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, container, started_at)
       VALUES (?, ?, ?, ?, NULL, 'failed', ?, ?, ?, ?)`,
    )
    .run(opts.ticketId, opts.service, opts.host, opts.port, opts.logPath, opts.cwd, opts.container ?? null, spawnedAt);
}

export interface StartHotOpts {
  ticketId: number | null;
  service: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  host: string;
  port: number;
  healthUrl: string;
  logPath: string;
  /**
   * The repository root the service belongs to — the boundary for reclaiming a
   * port from a conflicting dev server (see `runtime/portConflict.ts`): a
   * process whose cwd is inside it is a dev server of this repo and may be
   * reaped; anything outside it is a stranger and never touched.
   */
  repoPath: string;
  /**
   * The docker container this service runs in (`runtime/dockerCommand.ts`), when
   * the manifest declared an image rather than a start command.
   *
   * Two things follow from it, and both are the difference between a container
   * service and a leak: any LEFTOVER container of the same name is removed
   * before the spawn (docker refuses to start a second container under a name
   * already taken, so a crashed previous run would block every retry), and the
   * name is recorded on the row so every stop and reap path can remove the
   * container itself rather than only the client attached to it.
   */
  container?: string;
  /**
   * Require the health response to identify itself as this start
   * (`service.healthIdentity`). karst mints one token per start, puts it in the
   * spawn env as `KARST_INSTANCE_TOKEN`, and accepts the health check only from
   * a response that echoes it in `X-Karst-Instance`. Off → reachability is the
   * whole test, and another worktree's service on the port passes for ours.
   */
  requireIdentity?: boolean;
  healthTimeoutMs?: number;
  /** Abort the health-gated start early (spin cancellation). */
  signal?: AbortSignal;
  /**
   * Fired once per process karst killed to free the port — a conflicting dev
   * server of this repository, or a karst-recorded server of another ticket.
   * The spin flow uses it to REPORT the reap: a killed dev server is the
   * user's own process, and an unreported reap is how a "why did my dev
   * server die?" mystery starts (the archive paths raise the same warning).
   */
  onReclaim?: (pid: number) => void;
  /**
   * The lookup environment `prepareCommand` resolves the spawn through. Only
   * tests inject this — production leaves it undefined so the live machine's
   * `realShimEnv()` is used. Exposed because the Windows `.cmd` translation is
   * otherwise unobservable off Windows.
   */
  shimEnv?: ShimEnv;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[runtime]`.
   * Absent → no debug lines; the host binds it to `Logger.debug` (a no-op
   * unless the manifest's `debug` flag is on).
   */
  debug?: (message: string) => void;
}

/**
 * Start a hot service, health-gate it, and record it in `servers` (§10, §7.2
 * step 4). Resolves only after the health check passes; if health never passes,
 * the child is killed and the call rejects. stdout/stderr stream to logPath.
 */
/**
 * Why a service wouldn't start, in words the user can act on.
 *
 * Service commands are arbitrary strings from the manifest, so karst cannot
 * preflight them the way it preflights its own tools (see runtime/deps.ts) —
 * this is the only place a typo'd or uninstalled service command can be
 * explained. Name the service, the binary, and where it was configured; "spawn
 * docker ENOENT" is true and useless.
 */
function startError(opts: StartHotOpts, err: Error & { code?: string }): Error {
  if (err.code === 'ENOENT') {
    return new Error(
      `could not start '${opts.service}': '${opts.command}' is not installed, or not on the ` +
        `PATH this editor was launched with. It comes from the start command for '${opts.service}' ` +
        `in karst.yml.`,
    );
  }
  return new Error(`could not start '${opts.service}': ${err.message}`);
}

/** Rejects with `err` after `ms`, without holding the process open. */
function rejectAfter(ms: number, err: Error): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(err), ms).unref());
}

/**
 * How much of a failed service's own log to carry into the start-failure error.
 * Bounded so a runaway service (a 250 KB log) cannot blow up the error toast.
 */
const START_FAILURE_LOG_TAIL_BYTES = 2_000;

/**
 * Read the LAST `maxBytes` of a server log, for surfacing WHY a service failed
 * to become healthy. Bounded (a runaway log must not blow up the error), and
 * tolerant: a missing/unreadable log returns '' so the caller's message stands
 * on its own.
 */
function readLogTail(logPath: string, maxBytes = START_FAILURE_LOG_TAIL_BYTES): string {
  try {
    const { size } = statSync(logPath);
    if (size <= 0) return '';
    const fd = openSync(logPath, 'r');
    try {
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Wrap a start failure with the service's own log tail so the user sees WHY it
 * died — a missing module, a wrong port in config — without opening the log
 * file (the reported failure: `node server.mjs` with no such file surfaced only
 * "the process exited with code 1"; the MODULE_NOT_FOUND was buried in the log).
 * The log path is ALWAYS named (a failed start must stay debuggable); the tail
 * is appended only when the log actually holds output.
 */
function startFailure(opts: StartHotOpts, err: unknown, portState = ''): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  const tail = readLogTail(opts.logPath);
  return new Error(
    `${base.message}${portState}${tail.length > 0 ? `\nLast output:\n${tail}` : ''}\nSee the log: ${opts.logPath}`,
  );
}

/**
 * How long after a launcher exits karst waits before calling the start dead.
 * A launcher that daemonises (`docker compose up -d`) exits BEFORE the process
 * it left behind has bound its port, so an immediate verdict would fail a start
 * that is merely a few hundred milliseconds from healthy.
 */
const DAEMONISE_GRACE_MS = 2_000;
/** How often the abandoned-start check re-asks while inside that grace. */
const ABANDON_POLL_MS = 250;

/**
 * What the OS says about the child's process group.
 *
 * `unknown` is its own answer, deliberately: Windows has no process group to
 * signal-probe, and collapsing "cannot tell" into "empty" is how the grace
 * period stopped applying there — a daemonising launcher was failed one poll
 * after it exited, on a platform where karst has no evidence either way.
 */
type GroupLiveness = 'alive' | 'empty' | 'unknown';

function groupLiveness(pid: number): GroupLiveness {
  if (process.platform === 'win32') return 'unknown'; // no process groups to ask about
  try {
    process.kill(-pid, 0);
    return 'alive';
  } catch (err) {
    // EPERM means the group exists and we were refused — very much alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'empty';
  }
}

export interface AbandonInputs {
  /** Is anything listening on the service's port? */
  portOpen: boolean;
  group: GroupLiveness;
  /** Has the daemonise grace period elapsed? */
  graceElapsed: boolean;
}

/**
 * The abandoned-start rule, as one pure decision:
 *
 *  - `serving` — stop asking; this is the health check's question now.
 *  - `wait` — undecided, poll again.
 *  - `abandoned` — nothing can ever answer; fail now instead of at the deadline.
 *
 * A listener settles it whatever else is true. Everything else waits the grace
 * out first — an `empty` group included: a launcher that DETACHES its daemon
 * (`spawn(..., { detached: true }).unref()`, `docker compose up -d`) leaves an
 * empty group of its own the instant it exits, while the process it left
 * behind — in a group of its own — is still binding the port. Abandoning on
 * that alone failed exactly the daemonising start the grace exists for, on any
 * machine slow enough that the daemon needed more than one poll. Past the
 * grace, an `empty` or `unknown` group means nothing is left that could ever
 * answer; a group still `alive` is a slow starter, which health, not this, is
 * there to time out.
 */
export function abandonVerdict(inputs: AbandonInputs): 'serving' | 'wait' | 'abandoned' {
  if (inputs.portOpen) return 'serving';
  if (!inputs.graceElapsed) return 'wait';
  return inputs.group === 'alive' ? 'serving' : 'abandoned';
}

/**
 * Reject as soon as a start is ABANDONED: the launcher has exited, the
 * daemonise grace has elapsed with its process group still empty, and nothing
 * is listening on the port. Each of those alone is legal — a daemonising
 * launcher exits 0 and its own group empties at once, a slow build has not
 * bound yet — but together, past the grace, they mean there is no process left
 * that could ever answer the health URL, so waiting out the deadline only
 * delays the same failure by 30 seconds and then blames the health check.
 *
 * Never resolves: it is raced against the health wait and only ever rejects.
 */
function abandonedStart(opts: StartHotOpts, pid: number, exited: Promise<void>): Promise<never> {
  return new Promise<never>((_, reject) => {
    void exited.then(async () => {
      const deadline = Date.now() + DAEMONISE_GRACE_MS;
      for (;;) {
        await new Promise((r) => setTimeout(r, ABANDON_POLL_MS).unref());
        const verdict = abandonVerdict({
          portOpen: await isPortOpen(opts.host, opts.port),
          group: groupLiveness(pid),
          graceElapsed: Date.now() >= deadline,
        });
        if (verdict === 'serving') return; // something bound it, or is still coming up
        if (verdict === 'wait') continue;
        opts.debug?.(
          `[runtime] ${opts.service}: launcher exited, process group empty, nothing on ` +
            `${opts.host}:${opts.port} — abandoning the start`,
        );
        reject(
          new Error(
            `could not start '${opts.service}': the process exited and left nothing listening on ` +
              `${opts.host}:${opts.port}.`,
          ),
        );
        return;
      }
    });
  });
}

/**
 * What the PORT showed when the health gate gave up — the half of the failure
 * "health check <url> did not pass within 30000ms" never mentioned. "Nothing is
 * listening" and "something is listening but never answered" are different
 * faults with different fixes, and the message that names neither sends the
 * reader to the wrong one. Best-effort: a probe that cannot answer adds nothing
 * rather than delaying or replacing the real error.
 */
async function describePortState(opts: StartHotOpts): Promise<string> {
  try {
    if (!(await isPortOpen(opts.host, opts.port))) {
      return `\nNothing is listening on ${opts.host}:${opts.port} — the service never bound its port.`;
    }
    const pids = await listenerPids(opts.host, opts.port);
    const who = pids.length > 0 ? `pid ${pids.join(', ')}` : 'a process karst cannot identify';
    return (
      `\nSomething is listening on ${opts.host}:${opts.port} (${who}) but it never answered ` +
      `${opts.healthUrl} with a 2xx.`
    );
  } catch {
    return '';
  }
}

export async function startHot(store: Store, opts: StartHotOpts): Promise<ServerRecord> {
  // A container service names its container deterministically, so a container
  // left behind by a crashed run (or by a kill that reached the client and not
  // the daemon) still holds that name. `docker run` fails outright on the
  // conflict, which would make every retry fail for a reason the user cannot see
  // from the log. Remove it first — awaited, because the spawn depends on it —
  // and tolerate every failure: "no such container" is the normal answer.
  if (opts.container) {
    await removeContainerAsync(opts.container, { debug: opts.debug });
  }
  // A port owner may answer the configured health URL (SPA fallbacks commonly
  // return index.html with 200 for every path) or may answer nothing useful at
  // all. Health therefore cannot identify the owner. Attribute every occupied
  // port before spawning: reclaim only dev servers of this repository or
  // karst-recorded servers, and refuse strangers without signalling them.
  if (await isPortOpen(opts.host, opts.port)) {
    opts.debug?.(
      `[runtime] ${opts.service}: port ${opts.host}:${opts.port} is occupied — attributing the owner`,
    );
    const reclaimed = await reclaimPort(store, opts.host, opts.port, opts.repoPath);
    for (const id of reclaimed.stoppedRows) markServerStopped(store, id);
    for (const pid of reclaimed.killedPids) opts.onReclaim?.(pid);
    if (reclaimed.killedPids.length > 0) {
      opts.debug?.(
        `[runtime] ${opts.service}: reclaimed port from pid(s) ${reclaimed.killedPids.join(', ')}`,
      );
    }
    if (!reclaimed.portFree) {
      const survivors = reclaimed.survivors
        .map((s) =>
          s.baseline
            ? `a baseline server karst runs for this repository${s.pid === null ? '' : ` (pid ${s.pid})`}`
            : s.pid === null
              ? 'a process karst cannot identify'
              : `pid ${s.pid} (not a dev server of this repository)`,
        )
        .join(', ');
      const stillBlocked = reclaimed.killedPids
        .map((pid) => `pid ${pid} (killed, but the port is still occupied)`)
        .join(', ');
      const blocker = [survivors, stillBlocked].filter((s) => s.length > 0).join('; ');
      const holder = blocker ? `${opts.host}:${opts.port} is in use by ${blocker} — ` : '';
      const advice =
        reclaimed.survivors.length === 0
          ? `The process was killed but its socket has not released — retry in a moment, ` +
            `or give '${opts.service}' a different port in karst.yml.`
          : `karst will not stop that process automatically. Stop the process on that port, ` +
            `or give '${opts.service}' a different port in karst.yml.`;
      throw new Error(`could not start '${opts.service}': ${holder}${advice}`);
    }
  }

  // Logs live in a subdirectory (`serverLogPath`), and a freshly created
  // worktree has none of it yet. Without this the ENOENT from `openSync` reads
  // as "the server failed to start", which is a lie about the server.
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const logFd = openSync(opts.logPath, 'a');

  // Written to the fd BEFORE the child is spawned, so its position in the file
  // is deterministic: everything after it belongs to this run. The pid is
  // deliberately absent — it is not known until `spawn` returns, and appending
  // the marker afterwards would race the child's first stdout write.
  writeSync(logFd, `${runMarkerLine(opts.service, new Date().toISOString())}\n`);

  // One token per START, not per service or per ticket: a restart must not be
  // satisfiable by the process the previous run left behind on the same port.
  const instanceToken = opts.requireIdentity ? randomUUID() : undefined;

  let child;
  try {
    // A service command is arbitrary manifest text, so it gets the same platform
    // translation the gates and `deps.ts` give theirs: on Windows a bare `npm`
    // is a `npm.cmd` batch shim Node refuses to spawn (ENOENT), and a relative
    // `./scripts/dev.sh` must be anchored to the worktree, not the extension
    // host. `prepareCommand` owns the shim rewrite; `resolveCommandCwd` owns the
    // anchor. Spawning `opts.command` raw is the ENOENT this exists to prevent.
    const prepared = prepareCommand(
      resolveCommandCwd(opts.command, opts.cwd),
      opts.args,
      opts.shimEnv,
    );
    child = spawn(prepared.command, prepared.args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...opts.env,
        ...(instanceToken ? { [INSTANCE_ENV]: instanceToken } : {}),
      },
      stdio: ['ignore', logFd, logFd],
      // Own process group so killTree can reap grandchildren (e.g. `npm run dev`
      // → Vite). Without this a health-fail/cancel orphans the real server.
      detached: true,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
    });
  } finally {
    // The child holds its own duplicated fd via the stdio array; close the
    // parent's copy so a long-running daemon doesn't leak one fd per start.
    closeSync(logFd);
  }

  // A failed spawn (ENOENT) reports itself through an ASYNC 'error' event, and an
  // 'error' event with no listener THROWS — unhandled, in the extension host, from
  // a stack naming neither the service nor the command. Listen before anything can
  // fire, and keep the rejection handled until something races it.
  const spawnFailed = new Promise<never>((_, reject) => {
    child.once('error', (err: Error & { code?: string }) => reject(startError(opts, err)));
  });
  spawnFailed.catch(() => {});

  // A process that DIED cannot be the thing answering /health — something else on
  // the port is (a leaked server from a previous run, an unrelated app). Without
  // this race that foreign 200 was accepted and the dead pid recorded as
  // 'running', so the dashboard offered a server nothing could stop or restart.
  // Only a NON-ZERO exit counts: a launcher that daemonises (`docker compose up
  // -d`) legitimately exits 0 and gets healthy afterwards.
  // Every exit, whatever its code, so the abandoned-start check below can ask
  // what the launcher LEFT BEHIND. A clean exit is not a failure by itself —
  // that is the whole point of the daemonise path — but it is the moment the
  // question becomes answerable.
  let noteExit = (): void => {};
  const childExited = new Promise<void>((resolve) => {
    noteExit = resolve;
  });
  const exitedBadly = new Promise<never>((_, reject) => {
    child.once('exit', (code, signal) => {
      noteExit();
      if (code === 0) return; // daemonised launcher — keep waiting for health
      const how = code === null ? `on ${signal}` : `with code ${code}`;
      reject(
        new Error(
          `could not start '${opts.service}': the process exited ${how} before it became ` +
            `healthy.`,
        ),
      );
    });
  });
  exitedBadly.catch(() => {});

  const pid = child.pid;
  // Captured HERE, not at the INSERT below: the row is written only after the
  // health check passes, which can be seconds (or, for a slow build, much
  // longer) after the process actually started. `serverIdentity.ts` attributes
  // a live pid partly by matching this timestamp against the OS's own report of
  // when that pid started — recording the health-check-passed moment instead
  // would systematically skew every comparison by however long that check took.
  const spawnedAt = new Date().toISOString();
  if (pid === undefined) {
    // No pid means the spawn failed; the reason is a tick behind us on the
    // 'error' event. Wait for it rather than throw a bare "no pid" — but never
    // wait forever for an event that may not be coming. Both arms reject, so the
    // throw below is unreachable; it is what tells the compiler (and the next
    // reader) that this branch cannot fall through to a start with no process.
    try {
      await Promise.race([
        spawnFailed,
        rejectAfter(2000, new Error(`could not start '${opts.service}': no pid`)),
      ]);
    } catch (err) {
      // ENOENT and friends land here — the spawn never produced a process at
      // all, so this is the ONLY path that can name it. Record it the same as
      // any other failed start, or a bad command in karst.yml renders as no
      // server anywhere rather than a red row explaining why.
      recordFailedStart(store, opts);
      opts.debug?.(`[runtime] ${opts.service}: spawned without a pid — reporting the spawn error`);
      throw err;
    }
  }
  // If we reach here, pid is defined (the undefined branch throws)
  const knownPid = pid!;
  opts.debug?.(`[runtime] ${opts.service}: spawned pid ${knownPid}; waiting on ${opts.healthUrl}`);

  const abandoned = abandonedStart(opts, knownPid, childExited);
  abandoned.catch(() => {});

  try {
    // Race the spawn failure: an error that arrives after a pid did (EACCES on
    // the binary, say) would otherwise sit unheard until the health check times
    // out, turning an instant, explainable failure into a slow, silent one.
    await Promise.race([
      waitForHealth(opts.healthUrl, {
        timeoutMs: opts.healthTimeoutMs,
        signal: opts.signal,
        requireInstance: instanceToken,
      }),
      spawnFailed,
      exitedBadly,
      abandoned,
    ]);
  } catch (err) {
    // Health failed or the start was cancelled — reap the whole tree, not just
    // the launcher, so no dev server is left running.
    opts.debug?.(
      `[runtime] ${opts.service}: health gate failed (${err instanceof Error ? err.message : String(err)}) — killing pid ${knownPid}`,
    );
    // A health TIMEOUT names only what karst watched, so add what the port
    // showed. Asked BEFORE the kill, deliberately: afterwards the port is free
    // because karst just freed it, and the answer would describe the aftermath
    // instead of the fault. Every other failure already says what happened (the
    // process exited, the command is missing) and needs no port reading.
    const portState = err instanceof HealthTimeoutError ? await describePortState(opts) : '';
    killTree(knownPid);
    // Killing the attached client leaves the CONTAINER running, and no `servers`
    // row exists yet — so nothing downstream will ever learn this name. Remove it
    // here or a timed-out, abandoned or cancelled start leaks a container holding
    // the port. Fire-and-forget: `docker rm -f` on an absent container is a no-op.
    if (opts.container) removeContainer(opts.container, { debug: opts.debug });
    // A user cancellation is quiet — no log tail, no fault banner, and no
    // failed row either: the user asked for this, it isn't a fault to show red.
    if (err instanceof HealthAbortedError) throw err;
    // Record the failure so the dashboard shows it (red, not just missing) and
    // its logs button can find `logPath` — the log the service just wrote is
    // exactly the evidence that explains what went wrong.
    recordFailedStart(store, opts);
    // Surface the service's own output so the failure explains itself: a missing
    // module, a wrong port in config, a compile error. Without this the user sees
    // only "exited with code 1" / "health did not pass" and must open the log.
    throw startFailure(opts, err, portState);
  }

  // Single row per (ticket, service): drop any prior row for this service first
  // — including a retained 'stopped' one from a previous run — so restarting a
  // stopped server replaces its offline row instead of accumulating duplicates.
  // `IS` is null-safe, so baseline servers (ticket_id NULL) match correctly.
  store.db
    .prepare('DELETE FROM servers WHERE repo = ? AND ticket_id IS ?')
    .run(opts.service, opts.ticketId);

  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at, container)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    )
    // `cwd` is recorded because the child is spawned `detached` — its own session
    // with no controlling tty — so nothing can ever reach it by hanging up a
    // terminal. The directory is the only remaining handle that ties this pid to
    // the tree it serves, and removing that tree (archive) or finding it gone (a
    // boot sweep) is what reaps it. `started_at` is written explicitly (the
    // captured `spawnedAt`, not the schema's `datetime('now')` default) for the
    // same reason: it is the other half of that attribution. See
    // runtime/worktreeServers.ts and runtime/serverIdentity.ts.
    .run(
      opts.ticketId,
      opts.service,
      opts.host,
      opts.port,
      pid,
      opts.logPath,
      opts.cwd,
      spawnedAt,
      opts.container ?? null,
    );

  return {
    id: Number(info.lastInsertRowid),
    ticketId: opts.ticketId,
    service: opts.service,
    host: opts.host,
    port: opts.port,
    pid: knownPid,
    status: 'running',
    logPath: opts.logPath,
    container: opts.container ?? null,
  };
}

interface ServerRow {
  pid: number | null;
  status: string;
  container: string | null;
  cwd: string | null;
  started_at: string | null;
}

/**
 * Kill a server's process and RETAIN its row as `status='stopped'` (pid nulled).
 * Idempotent (no row → no-op; already-stopped → no re-kill).
 *
 * The pid is signalled only when `serverIdentity.ts` can still attribute it to
 * the recorded server. A row karst can no longer prove is its own is retired
 * without a signal — the same rule the background reap follows
 * (`runtime/worktreeServers.ts`), for the same reason: `killTree` SIGKILLs a
 * process GROUP, and the OS reissues pids. The row is marked stopped either way,
 * because it is stale either way, and the container is removed either way,
 * because a container name karst chose is never reissued.
 *
 * The one exception is a REFUSED kill (`killTree` → `'denied'`, or a throw): the
 * process is provably still running, so a plain command row keeps its `running`
 * status rather than being erased and reported stopped. A container row is still
 * cleared, because removing the container by name stops it regardless of whether
 * the attached client could be signalled.
 *
 * ASYNC because the attribution probes are: on macOS the live start time comes
 * from `ps`, and this runs on the extension-host event loop (the dashboard's
 * Stop/restart, `spinTicket`'s pre-spin stop), where a synchronous spawn would
 * freeze every webview and the hook endpoint. The probes go through
 * `systemAsyncProcessFacts` and are resolved before the synchronous
 * `attributeServer` decides, exactly as `reclaimPort` does.
 *
 * Retaining rather than deleting lets a stopped server surface on the dashboard
 * as offline so the user can restart it, instead of silently vanishing. Duplicate
 * accumulation is prevented at the other end: `startHot` drops any prior row for
 * the same (ticket, repo) before inserting the fresh running one.
 */
export async function stopServer(
  store: Store,
  id: number,
  opts: { facts?: ProcessFactsSource } = {},
): Promise<void> {
  const row = store.db
    .prepare('SELECT pid, status, container, cwd, started_at FROM servers WHERE id = ?')
    .get(id) as ServerRow | undefined;
  if (!row) return;

  let denied = false;
  if (row.status === 'running' && row.pid != null) {
    const facts = opts.facts ?? systemAsyncProcessFacts;
    const resolved = await snapshotProcessFacts(facts, row.pid);
    const attribution = attributeServer(
      { pid: row.pid, cwd: row.cwd, startedAt: row.started_at },
      resolved,
    );
    if (attribution === 'attributable') {
      // Group kill so a launcher's grandchildren (Vite etc.) die with it.
      denied = killTree(row.pid) === 'denied';
    }
  }
  // The client is not the container. `docker run` attached gives karst a pid it
  // can group-kill, but the container survives that kill — port still bound,
  // memory still held — so it is removed by NAME, which is the handle that
  // cannot go stale. Unconditional: an already-stopped row may still have a
  // container behind it (a kill that reached the client only), and `docker rm
  // -f` on a container that is gone is a no-op.
  if (row.container) removeContainer(row.container);
  // A refused kill on a plain command leaves the process alive, so the row must
  // keep saying so. With a container the removal above has stopped it (docker
  // kills the process it runs), so the row may be cleared truthfully.
  if (denied && !row.container) return;
  markServerStopped(store, id);
}

/**
 * Record a server as stopped WITHOUT signalling anything.
 *
 * The row half of `stopServer`, separated because a reap may reach a row whose
 * pid it must not signal — one the OS has since reissued to an unrelated process
 * (see `runtime/serverIdentity.ts`). Such a row is still stale and still has to
 * stop claiming to be running; what it must not do is take a stranger's process
 * group with it. Idempotent.
 */
export function markServerStopped(store: Store, id: number): void {
  store.db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(id);
}

/**
 * Stop every running server belonging to a ticket. Used before a re-spin so a
 * prior run's live servers are reaped (process + row) instead of orphaned — a
 * retry that re-resolves the same port would otherwise spawn a second server
 * fighting the first for the port. Idempotent; each stop is isolated.
 */
export async function stopTicketServers(store: Store, ticketId: number): Promise<void> {
  const rows = store.db
    .prepare("SELECT id FROM servers WHERE ticket_id = ? AND status = 'running'")
    .all(ticketId) as { id: number }[];
  for (const { id } of rows) await stopServer(store, id);
}

/**
 * Delete a ticket's server rows whose repository name is no longer declared by
 * the manifest — the rows a repository RENAME orphans.
 *
 * `servers` is keyed by repository NAME (as are `port_allocations`), and
 * `startHot` replaces only a row of the SAME name. A retained `stopped` row is
 * normally the point (it surfaces as offline and can be restarted), but once its
 * manifest key is gone nothing can ever start it again: it rendered forever on
 * the dashboard beside the new name — the same stack listed twice, old and new —
 * behind a Restart button that could only fail.
 *
 * Membership in the MANIFEST is the test, deliberately, not membership in the
 * spin's hot set: a repository the user simply deselected for this spin is still
 * real and keeps its offline row.
 *
 * Ticket-scoped: baseline rows (`ticket_id IS NULL`) are shared across tickets
 * and are not one ticket's spin to reap.
 */
export function pruneOrphanServers(
  store: Store,
  ticketId: number,
  knownRepos: readonly string[],
): void {
  const placeholders = knownRepos.map(() => '?').join(',');
  const sql = knownRepos.length
    ? `DELETE FROM servers WHERE ticket_id = ? AND repo NOT IN (${placeholders})`
    : 'DELETE FROM servers WHERE ticket_id = ?';
  store.db.prepare(sql).run(ticketId, ...knownRepos);
}

/** Read the current contents of a server's log file (§10 log-tail). */
export function tailLog(record: Pick<ServerRecord, 'logPath'>): string {
  if (!existsSync(record.logPath)) return '';
  return readFileSync(record.logPath, 'utf8');
}
