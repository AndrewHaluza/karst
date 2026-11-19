import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { MAX_SETUP_REASON, SETUP_REPO_NAME } from '../proposal.js';
import { ITEMS } from './items.js';
import type { SkipRecord } from './types.js';

/**
 * Skips (@arch:CLI-21). The agent can only REQUEST one: a file in
 * `<outbox>/skips/`. The host shows the popup and, on approval, writes the
 * record to extension storage. The outbox is not a trust boundary, so the
 * checklist reads skips only from that store, never from the outbox.
 */

export interface SkipRequest {
  code: string;
  target?: string;
  reason: string;
}

export type SkipRequestResult = { ok: true; value: SkipRequest } | { ok: false; reason: string };

const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_STORE_BYTES = 256 * 1024;
const CODES: readonly string[] = ITEMS.map((i) => i.code);

export function validateSkipRequest(raw: unknown): SkipRequestResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'a skip request must be a JSON object' };
  const rec = raw as Record<string, unknown>;
  if (Object.keys(rec).some((k) => k !== 'code' && k !== 'target' && k !== 'reason')) {
    return { ok: false, reason: 'a skip request has only code, target and reason' };
  }
  if (typeof rec.code !== 'string' || !CODES.includes(rec.code)) {
    return { ok: false, reason: `code must be one of: ${CODES.join(', ')}` };
  }
  if (rec.target !== undefined && (typeof rec.target !== 'string' || !SETUP_REPO_NAME.test(rec.target) || rec.target === '.' || rec.target === '..')) {
    return { ok: false, reason: 'target must be a repository name' };
  }
  const reason = typeof rec.reason === 'string' && rec.reason.length <= MAX_SETUP_REASON ? rec.reason.replace(CONTROLS, '').trim() : '';
  if (reason === '') return { ok: false, reason: `reason must be a non-empty string of at most ${MAX_SETUP_REASON} characters` };
  const value: SkipRequest = { code: rec.code, reason };
  if (typeof rec.target === 'string') value.target = rec.target;
  return { ok: true, value };
}

/** One store per project: next to the store file, keyed by the manifest path. */
export function skipStorePath(db: string | undefined, manifestPath: string): string | undefined {
  if (db === undefined) return undefined;
  const key = createHash('sha256').update(resolve(manifestPath)).digest('hex').slice(0, 16);
  return join(dirname(db), 'setup-skips', `${key}.json`);
}

function asRecord(v: unknown): SkipRecord | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.code !== 'string' || !CODES.includes(r.code) || typeof r.reason !== 'string') return undefined;
  const out: SkipRecord = { code: r.code, reason: r.reason, at: typeof r.at === 'string' ? r.at : '' };
  if (typeof r.target === 'string') out.target = r.target;
  return out;
}

/** Every valid skip in the store; a missing or corrupt store gives none. */
export function readSkips(path: string | undefined): SkipRecord[] {
  if (path === undefined) return [];
  try {
    if (statSync(path).size > MAX_STORE_BYTES) return [];
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(raw) ? raw.map(asRecord).filter((s): s is SkipRecord => s !== undefined) : [];
  } catch {
    return [];
  }
}

/** Host only: add a skip the user approved. A repeat of the same code and target replaces the old one. */
export function addSkip(path: string, skip: SkipRecord): void {
  const kept = readSkips(path).filter((s) => !(s.code === skip.code && s.target === skip.target));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify([...kept, skip]), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Agent side: write one request as `<outbox>/skips/<id>.json`. */
export function writeSkipRequest(outbox: string, request: SkipRequest, uuid: () => string = randomUUID): string {
  const dir = join(outbox, 'skips');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${uuid()}.json`);
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmp, JSON.stringify(request), { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export type PendingSkipRequest =
  | { id: string; file: string; value: SkipRequest }
  /** A request file the host cannot use: the host removes it and records why. */
  | { id: string; file: string; error: string };

/** Host side: the pending requests of one outbox (valid or not), oldest name first. */
export function readSkipRequests(outbox: string): PendingSkipRequest[] {
  const dir = join(outbox, 'skips');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PendingSkipRequest[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const file = join(dir, name);
    const id = basename(name, '.json');
    try {
      if (statSync(file).size > MAX_REQUEST_BYTES) {
        out.push({ id, file, error: `the request is larger than ${MAX_REQUEST_BYTES} bytes` });
        continue;
      }
      const checked = validateSkipRequest(JSON.parse(readFileSync(file, 'utf8')));
      out.push(checked.ok ? { id, file, value: checked.value } : { id, file, error: checked.reason });
    } catch (e) {
      out.push({ id, file, error: `unreadable: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return out;
}
