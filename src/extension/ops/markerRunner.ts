import type { MarkerRunner } from '../../agent/bridge/bridgeSink.js';
import type { EnsureSyncResult } from './sandboxSyncOps.js';
import { spawnHeadlessCli, type HeadlessSpawnResult } from '../../agent/headlessSpawn.js';

/** The async spawn seam (production: `spawnHeadlessCli`; never `spawnSync`). */
export type MarkerSpawn = (command: string, args: readonly string[], cwd: string) => Promise<HeadlessSpawnResult>;

/** Host facts for one ticket's done-marker CLI run; none come from the bridge line. */
export interface MarkerRunnerFacts {
  /** `process.execPath` in production. */
  readonly nodePath: string;
  readonly cliEntry: string;
  readonly dbPath: string;
  readonly manifestPath: string;
  readonly ticketKey: string;
  readonly cwd: string;
  /**
   * Sandboxed tickets only: bring the sandbox's commits into the host worktree
   * BEFORE the stage CLI runs (arch:AC-32 choke point). Absent for a host ticket.
   */
  readonly ensureSynced?: () => Promise<EnsureSyncResult>;
}

/** The CLI refusals that a retry cannot change (empty work, wrong stage, guard). Anything else is transient. */
const PERMANENT_REFUSAL = /cannot (mark|advance)|refused|unknown verdict/i;

/**
 * Runs `karst stage <stage> pass` on the HOST for a verified sandbox marker
 * (arch:AC-34): the same CLI path a host session's marker takes. A sandboxed
 * ticket is synced first (fast-forward only); a sync failure never reaches the CLI.
 */
export function createMarkerRunner(
  facts: MarkerRunnerFacts,
  spawn: MarkerSpawn = (command, args, cwd) => spawnHeadlessCli(command, args, cwd),
): MarkerRunner {
  return async (stage) => {
    if (facts.ensureSynced) {
      const synced = await facts.ensureSynced();
      if (!synced.ok) return { code: 1, stderr: synced.reason, transient: !synced.diverged, diverged: synced.diverged };
    }
    const args = [
      facts.cliEntry, 'stage', stage, 'pass',
      '--db', facts.dbPath, '--manifest', facts.manifestPath, '--ticket', facts.ticketKey,
    ];
    const result = await spawn(facts.nodePath, args, facts.cwd);
    return result.exitCode === 0
      ? { code: 0, stderr: result.stderr }
      : { code: result.exitCode, stderr: result.stderr, transient: !PERMANENT_REFUSAL.test(result.stderr) };
  };
}
