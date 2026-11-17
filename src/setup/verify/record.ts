import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { VerifyRecord } from './types.js';

/**
 * The host-side verify record. It lives in extension storage, outside the
 * agent's outbox, so only the host writes it: unlike the outbox `results/`
 * ledger, an agent cannot forge a `verified` here. `setup status` reads it
 * through `KARST_SETUP_VERIFY_DIR`.
 */
export const SETUP_VERIFY_ENV = 'KARST_SETUP_VERIFY_DIR';

const ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_RECORD_BYTES = 256 * 1024;
const STATUSES: readonly string[] = ['verified', 'unverified', 'refused'];

export function writeVerifyRecord(dir: string, record: VerifyRecord): void {
  if (!ID.test(record.id)) throw new Error(`invalid proposal id for a verify record: ${record.id}`);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, join(dir, `${record.id}.json`));
}

function readRecord(file: string): VerifyRecord | undefined {
  try {
    if (statSync(file).size > MAX_RECORD_BYTES) return undefined;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<VerifyRecord>;
    if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status)) return undefined;
    if (!Array.isArray(raw.steps) || !Array.isArray(raw.changes)) return undefined;
    return {
      id: basename(file, '.json'),
      kind: raw.kind === 'change' ? 'change' : 'manifest',
      status: raw.status as VerifyRecord['status'],
      steps: raw.steps,
      changes: raw.changes,
      pinnedSha256: typeof raw.pinnedSha256 === 'string' ? raw.pinnedSha256 : null,
      at: typeof raw.at === 'string' ? raw.at : '',
    };
  } catch {
    return undefined;
  }
}

/** Every valid record in `dir`; an unreadable file or a missing directory gives none. */
export function readVerifyRecords(dir: string | undefined): VerifyRecord[] {
  if (dir === undefined || dir === '') return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: VerifyRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || !ID.test(basename(name, '.json'))) continue;
    const record = readRecord(join(dir, name));
    if (record !== undefined) out.push(record);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
