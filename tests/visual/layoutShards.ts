/**
 * Shared shard IO for the layout projects. Each route x width test writes one
 * JSON shard; layout.teardown.ts merges them. Node-side only.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LayoutFailure, RegionExpectations } from '../../src/ui/layout/layoutChecks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHARD_DIR = join(HERE, '.layout-shards');
export const REPORT_PATH = join(HERE, '.layout-report.json');
export const LEDGER_PATH = join(HERE, 'layout-known-failures.json');
const EXPECTATIONS_DIR = join(HERE, 'expectations');

export interface Shard {
  readonly route: string;
  readonly width: number;
  readonly failures: readonly LayoutFailure[];
  /** No region expectations for this route: check g did not run. */
  readonly unchecked: boolean;
}

export function resetShards(): void {
  rmSync(SHARD_DIR, { recursive: true, force: true });
  mkdirSync(SHARD_DIR, { recursive: true });
}

export function writeShard(shard: Shard): void {
  mkdirSync(SHARD_DIR, { recursive: true });
  const name = `${shard.route}-${shard.width}`.replace(/[^A-Za-z0-9._-]+/g, '_');
  writeFileSync(join(SHARD_DIR, `${name}.json`), `${JSON.stringify(shard)}\n`);
}

export function readShards(): Shard[] {
  try {
    return readdirSync(SHARD_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(SHARD_DIR, f), 'utf8')) as Shard);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** `undefined` when the section has no expectations file (route reports "unchecked"). */
export function readExpectations(section: string): RegionExpectations | undefined {
  try {
    return JSON.parse(readFileSync(join(EXPECTATIONS_DIR, `${section}.json`), 'utf8')) as RegionExpectations;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`expectations/${section}.json is unreadable: ${(err as Error).message}`);
  }
}

/** The ledger file's keys, or null when it does not exist. */
export function readLedger(): string[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every((k) => typeof k === 'string')) {
      throw new Error('expected a JSON array of failure keys');
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`layout-known-failures.json is unreadable: ${(err as Error).message}`);
  }
}

export function writeLedger(keys: readonly string[]): void {
  writeFileSync(LEDGER_PATH, `${JSON.stringify(keys, null, 2)}\n`);
}
