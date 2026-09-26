import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from '../store/db.js';
import { markServerStopped } from './supervisor.js';
import { killTree } from './processTree.js';
import { removeContainer } from './dockerContainer.js';
import { isPathUnder } from './pathScope.js';
import { attributeServer, systemProcessFacts, type ProcessFacts } from './serverIdentity.js';

/**
 * A server this module acted on, what it was acted on for, and what actually
 * happened to it.
 *
 * Returned rather than logged so the caller (which owns the output channel)
 * states it in its own words — and so a silent reap is impossible: waste that
 * nothing reports is exactly how two ~1 GB dev servers survived three days
 * unnoticed (869ed2n50). `outcome` is the OUTCOME, never the intent: a row whose
 * pid could not be attributed is cleared without a signal, and a kill that was
 * REFUSED (`killTree` returning `'denied'`, or throwing) says so and leaves the
 * row untouched, rather than being reported — and recorded — as a stop that
 * happened.
 */
export interface ReapedServer {
  id: number;
  repo: string;
  pid: number | null;
  cwd: string;
  reason: 'worktree-removed' | 'directory-gone';
  /**
   * The docker container removed alongside the process, or null when the service
   * was a plain command. Reported for the same reason the pid is: a container
   * removal the user cannot see is indistinguishable from one that never
   * happened.
   */
  container: string | null;
  outcome:
    /** The process group was signalled (or was already gone) and the row cleared. */
    | 'killed'
    /** Stale row cleared; nothing was signalled (dead, reissued, or unknowable pid). */
    | 'row-cleared'
    /** The kill was refused — still running. Row left untouched; reported, never swallowed. */
    | 'kill-failed';
}

export interface ReapOptions {
  /** OS probes; injected so tests never depend on this machine's processes. */
  facts?: ProcessFacts;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[runtime]`.
   * Absent → no debug lines; the host binds it to `Logger.debug` (a no-op
   * unless the manifest's `debug` flag is on).
   */
  debug?: (message: string) => void;
}

interface ServerRow {
  id: number;
  repo: string;
  pid: number | null;
  cwd: string | null;
  started_at: string | null;
  container: string | null;
}

/**
 * Every server the registry believes is running, with a KNOWN directory.
 *
 * `ticketOnly` excludes baseline servers (`ticket_id IS NULL`) — a shared
 * singleton keyed to the repository checkout itself, not to a worktree that can
 * be removed. `stopServersUnder` never needs this: it already matches by PATH
 * against one specific worktree, and a baseline server's cwd (the parent
 * checkout) cannot be under a nested `.karst/worktrees/<slug>` path — the two
 * scopes agree by construction. `reapStaleServers` does need it: it is the
 * unattended global sweep, and its blast radius on a false positive is every
 * ticket sharing that baseline, not one worktree's leftover.
 */
function runningWithCwd(store: Store, opts: { ticketOnly?: boolean } = {}): ServerRow[] {
  const scope = opts.ticketOnly ? 'AND ticket_id IS NOT NULL' : '';
  return store.db
    .prepare(
      `SELECT id, repo, pid, cwd, started_at, container FROM servers WHERE status = 'running' AND cwd IS NOT NULL ${scope}`,
    )
    .all() as ServerRow[];
}

/**
 * Stop one row, signalling only a pid that is provably still ours, and report
 * what actually happened. Never throws: reaping is cleanup, and one bad row must
 * not abort the removal or the sweep it rides on.
 *
 * Goes straight to `killTree` rather than through `stopServer` — `stopServer`'s
 * contract (used by the dashboard's Stop button and by spin teardown) is to
 * ALWAYS mark a row stopped once a kill is attempted, because those callers act
 * on a server the user or the current run is known to own. A background reap has
 * no such standing, and `killTree` distinguishes "signalled" from "refused,
 * still running" (`processTree.ts`): only a refusal is reported as failure, and
 * only a refusal leaves the row untouched — a denied kill must not also erase
 * the only record that the process is still there.
 */
function reap(
  store: Store,
  row: ServerRow,
  cwd: string,
  reason: ReapedServer['reason'],
  facts: ProcessFacts,
  debug?: (message: string) => void,
): ReapedServer {
  const base = { id: row.id, repo: row.repo, pid: row.pid, cwd, reason, container: row.container };

  // The container comes FIRST and is removed on every path, including the ones
  // that deliberately signal nothing. A pid may have been reissued to a stranger
  // — that is why attribution can refuse — but a container NAME karst chose is
  // never reissued, so it stays a valid handle exactly when the pid stops being
  // one. Skipping it there would leave the container running with its port bound
  // and its memory held, invisible: the leak this whole module exists to close.
  if (row.container) {
    debug?.(`[runtime] reap '${row.repo}': removing container ${row.container}`);
    removeContainer(row.container, { debug });
  }
  const attribution = attributeServer(
    { pid: row.pid, cwd: row.cwd, startedAt: row.started_at },
    facts,
  );

  if (attribution !== 'attributable') {
    // Dead, reissued to someone else, or undecidable: the row is stale either
    // way and stops claiming to run, but nothing is signalled. `killTree` sends
    // SIGKILL to the process GROUP, so a wrong answer here would take down an
    // unrelated process tree.
    debug?.(
      `[runtime] reap '${row.repo}' (pid ${row.pid ?? 'none'}): attribution says '${attribution}' — clearing the row, signalling nothing`,
    );
    try {
      markServerStopped(store, row.id);
    } catch {
      /* best-effort */
    }
    return { ...base, outcome: 'row-cleared' };
  }

  let outcome: ReapedServer['outcome'];
  try {
    // `attribution === 'attributable'` guarantees `row.pid` is a positive int.
    // Only a CONFIRMED kill may clear the row: 'denied' and 'unknown' both mean
    // the process may still be running, and clearing it would erase the only
    // record that it is (the Windows taskkill-unknown leak this closes).
    outcome = killTree(row.pid!) === 'killed' ? 'killed' : 'kill-failed';
  } catch {
    outcome = 'kill-failed';
  }
  debug?.(
    `[runtime] reap '${row.repo}' (pid ${row.pid}): signalled — ${outcome}`,
  );

  if (outcome === 'killed') {
    try {
      markServerStopped(store, row.id);
    } catch {
      /* best-effort */
    }
  }
  // A denied kill leaves the row exactly as it was: the process is still
  // running, so 'running' is still the true state, not a stale one.
  return { ...base, outcome };
}

/**
 * Stop every running server whose working directory is at or under `root`.
 *
 * This is the pre-step to removing a worktree, and it is the fix for the whole
 * orphan class: `git worktree remove --force` deletes the tree out from under a
 * dev server karst itself started, and nothing else can ever reach that process
 * afterwards. It was spawned `detached` (its own session, no controlling tty),
 * so closing the terminal sends it no hangup; it is reparented to init, keeps
 * its port bound and its memory held, and serves a directory that no longer
 * exists — while the dashboard shows nothing, because the row went with the
 * ticket. Killing before the removal is the only moment both the pid and the
 * path are still known.
 *
 * Matching is by PATH, not by repository name: `servers.repo` is a repository
 * NAME and several repository entries may share one worktree (a monorepo with
 * two runnable services), so the name cannot answer "which tree does this
 * process serve". A row with a NULL cwd (written before v21) is left alone —
 * unknown is not "under this path".
 */
export function stopServersUnder(store: Store, root: string, opts: ReapOptions = {}): ReapedServer[] {
  const facts = opts.facts ?? systemProcessFacts;
  const reaped: ReapedServer[] = [];
  for (const row of runningWithCwd(store)) {
    const cwd = row.cwd!;
    if (!isPathUnder(cwd, root)) continue;
    opts.debug?.(
      `[runtime] stopServersUnder ${root}: '${row.repo}' (pid ${row.pid ?? 'none'}) serves ${cwd} — reaping`,
    );
    reaped.push(reap(store, row, cwd, 'worktree-removed', facts, opts.debug));
  }
  return reaped;
}

/**
 * Is `cwd` GONE, as opposed to momentarily unreachable?
 *
 * Absence alone does not mean deleted: a network share or an ejected volume
 * takes every path under it with it, and a sweep that read that as "the worktree
 * was removed" would kill live servers over a blip. Two answers, strongest
 * first:
 *
 *  1. The OS, where it will say (Linux `/proc/<pid>/cwd`): a directory removed
 *     out from under a running process resolves with the ` (deleted)` suffix.
 *     That is direct evidence about THIS process, and it is what the incident
 *     was diagnosed from.
 *  2. Otherwise, absence plus a PRESENT PARENT. A `git worktree remove` takes
 *     the leaf and leaves `<repo>/.karst/worktrees/` standing; an unmounted
 *     volume takes both, and is therefore not answered here.
 */
function directoryGone(cwd: string, pid: number | null, facts: ProcessFacts): boolean {
  const live = pid == null ? null : facts.liveCwd(pid);
  if (live && live.path === cwd) return live.deleted;
  if (existsSync(cwd)) return false;
  const parent = dirname(cwd);
  return parent !== cwd && existsSync(parent);
}

/**
 * Stop every running server whose directory has since vanished — the safety net
 * for the servers already leaked, and for any removal that did not go through
 * `removeWorktree` (a hand-run `git worktree remove`, the IDE's git extension, a
 * manual `rm -rf`).
 *
 * Safe by construction on the serving side: a server whose tree is gone cannot
 * be serving anything valid — the build output it answers with is deleted — so
 * there is no case where the right answer is to keep it. Safe on the signalling
 * side because every kill is attributed first (`serverIdentity.ts`); a row is
 * judged only on a directory karst itself recorded at spawn, never on a guess.
 *
 * Ticket-scoped ONLY: a baseline server (`ticket_id IS NULL`) is a shared
 * singleton keyed to the repository's own checkout, not to a removable
 * worktree — "its directory is gone" is not a state that class of row is
 * expected to reach in the first place, and this is a global, unattended sweep
 * whose false-positive blast radius would be every ticket sharing it.
 */
export function reapStaleServers(store: Store, opts: ReapOptions = {}): ReapedServer[] {
  const facts = opts.facts ?? systemProcessFacts;
  const reaped: ReapedServer[] = [];
  for (const row of runningWithCwd(store, { ticketOnly: true })) {
    const cwd = row.cwd!;
    if (!directoryGone(cwd, row.pid, facts)) continue;
    opts.debug?.(
      `[runtime] reapStaleServers: '${row.repo}' (pid ${row.pid ?? 'none'}) — directory gone, reaping`,
    );
    reaped.push(reap(store, row, cwd, 'directory-gone', facts, opts.debug));
  }
  return reaped;
}

/** One line per reap, for an output channel. Names the path, so it is checkable. */
export function describeReap(s: ReapedServer): string {
  const pid = s.pid ?? 'unknown';
  const why = s.reason === 'directory-gone' ? 'its directory is gone' : 'its worktree was removed';
  // Stated separately from the pid outcome, because it is a separate fact: the
  // container is removed even when nothing was signalled.
  const container = s.container ? ` Removed container '${s.container}'.` : '';
  switch (s.outcome) {
    case 'killed':
      return `karst: stopped '${s.repo}' (pid ${pid}) — ${why}: ${s.cwd}.${container}`;
    case 'row-cleared':
      return (
        `karst: cleared the stale record for '${s.repo}' (pid ${pid}) — ${why}: ${s.cwd}. ` +
        `Nothing was signalled: that pid can no longer be shown to be the server karst started.${container}`
      );
    case 'kill-failed':
      return `karst: could NOT stop '${s.repo}' (pid ${pid}) — ${why}: ${s.cwd}. It is still running.${container}`;
  }
}
