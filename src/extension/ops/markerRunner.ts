import type { MarkerRunner } from '../../agent/bridge/bridgeSink.js';
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
}

/**
 * Runs `karst stage <stage> pass` on the HOST for a verified sandbox marker
 * (arch:AC-34): the same CLI path a host session's marker takes.
 */
export function createMarkerRunner(
  facts: MarkerRunnerFacts,
  spawn: MarkerSpawn = (command, args, cwd) => spawnHeadlessCli(command, args, cwd),
): MarkerRunner {
  return async (stage) => {
    const args = [
      facts.cliEntry, 'stage', stage, 'pass',
      '--db', facts.dbPath, '--manifest', facts.manifestPath, '--ticket', facts.ticketKey,
    ];
    const result = await spawn(facts.nodePath, args, facts.cwd);
    return { code: result.exitCode, stderr: result.stderr };
  };
}
