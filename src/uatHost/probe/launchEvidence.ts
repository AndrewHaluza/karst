import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAUNCH_DIR_ENV } from '../../agent/launchStub.js';
import { normalizeLaunch, parseLaunches, type LaunchRecord } from '../launchRecord.js';

/** Launches the stub recorded, normalized so the same script gives byte-identical evidence. */
export function readLaunches(env: Record<string, string | undefined> = process.env): LaunchRecord[] {
  const dir = env[LAUNCH_DIR_ENV];
  const file = dir ? join(dir, 'launches.ndjson') : undefined;
  if (!file || !existsSync(file)) return [];
  return parseLaunches(readFileSync(file, 'utf8')).map(normalizeLaunch);
}
