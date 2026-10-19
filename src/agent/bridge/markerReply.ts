import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MarkerStage } from '../markerStage.js';
import type { BridgePaths } from './bridgeDir.js';

/**
 * What the host tells the agent about one marker line (arch:AC-34). Advisory
 * text for the agent only: the host never reads a result file back.
 * `retrying` = a transient failure the host will retry on its own.
 */
export interface MarkerReply {
  readonly v: 1;
  readonly stage: MarkerStage;
  readonly ok: boolean;
  readonly retrying: boolean;
  readonly reason: string;
}

/** A marker line's `seq` becomes a file name: only this shape is ever accepted. */
export const SEQ_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Write `<resultsDir>/<seq>.json` atomically (temp + rename); the reader never sees a partial file. */
export async function writeMarkerReply(paths: BridgePaths, seq: string, reply: MarkerReply): Promise<void> {
  if (!SEQ_PATTERN.test(seq)) throw new Error(`bridge: invalid marker seq`);
  await mkdir(paths.resultsDir, { recursive: true, mode: 0o755 });
  const target = join(paths.resultsDir, `${seq}.json`);
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(reply), { flag: 'wx', mode: 0o644 });
  await rename(temporary, target);
}
