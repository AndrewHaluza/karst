import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { QuotaReader, QuotaSnapshot, QuotaWindow } from './types.js';

/**
 * Codex quota reader — the CLI's own local session JSONL (`arch:AC-29`).
 *
 * Codex appends a `token_count` event carrying `rate_limits` on every model
 * turn, so the newest session file's last such line is the freshest
 * provider-reported window state. Zero model requests, zero network calls, no
 * credentials touched (it is a plain file under `$CODEX_HOME`/`~/.codex`).
 *
 * ALL I/O here is async: the reader runs on the extension host's event loop
 * (activation and every poll), so a synchronous walk of a heavy user's
 * thousands of rollouts, or a synchronous read of a tens-of-MB JSONL, would
 * freeze webviews, terminals and gate callbacks. The newest rollout is read
 * from its TAIL only (bounded), scanned backwards for the last `rate_limits`
 * line — a corrupt or truncated line is skipped, never fatal.
 */

const SOURCE = 'Codex session rate limits';

/** How much of a rollout's tail to scan. The last `token_count` sits at the end. */
const TAIL_BYTES = 1 << 20; // 1 MiB

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A finite, non-negative number; anything else is not a count. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A window length in minutes as a compact label (`5h`, `7-day`, `30-day`). */
export function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${Math.round(minutes)}-min`;
}

/** A Unix-seconds reset stamp as ISO-8601, or null when it is not a stamp. */
function resetsAtIso(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  const ms = seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Map one Codex `rate_limits` object to windows. A missing/null window is
 * skipped; a window whose `used_percent` is not a number is skipped too (never
 * coerced to 0 — a fabricated 0% is the one wrong answer this view must not
 * give). Returns [] when nothing usable is present.
 */
export function parseCodexRateLimits(raw: unknown): QuotaWindow[] {
  const limits = asRecord(raw);
  if (!limits) return [];
  const windows: QuotaWindow[] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const win = asRecord(limits[key]);
    if (!win) continue;
    const used = num(win['used_percent']);
    if (used === null) continue;
    const minutes = num(win['window_minutes']);
    windows.push({
      label: windowLabel(minutes, key),
      usedPct: Math.max(0, Math.min(100, used)),
      resetsAt: resetsAtIso(num(win['resets_at'])),
    });
  }
  return windows;
}

/** The Codex config root: `CODEX_HOME` override, else `<home>/.codex`. */
export function codexHome(env?: NodeJS.ProcessEnv, home: string = homedir()): string {
  const override = env?.CODEX_HOME;
  return typeof override === 'string' && override.length > 0 ? override : join(home, '.codex');
}

/** The newest `rollout-*.jsonl` under a sessions tree, or null. Async walk. */
export async function findLatestCodexSessionFile(baseDir: string): Promise<string | null> {
  let newest: string | null = null;
  let newestMtime = -Infinity;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try {
          const mtime = (await stat(full)).mtimeMs;
          if (mtime > newestMtime) {
            newestMtime = mtime;
            newest = full;
          }
        } catch {
          // vanished between listing and stat — skip
        }
      }
    }
  };
  await walk(baseDir, 0);
  return newest;
}

/** The last `maxBytes` of a file as UTF-8 text (async, bounded). */
async function readTail(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The last `rate_limits` object in a Codex rollout JSONL text, read from the
 * tail. Returns null when no line carries one.
 */
export function readCodexRateLimitsFrom(text: string): unknown | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('rate_limits')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // truncated mid-write line (or the tail's cut first line)
    }
    const payload = asRecord(asRecord(parsed)?.['payload']);
    const rateLimits = payload?.['rate_limits'];
    if (rateLimits !== undefined) return rateLimits;
  }
  return null;
}

export interface CodexQuotaDeps {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Read Codex quota from the newest local session file. */
export async function readCodexQuota(deps: CodexQuotaDeps = {}): Promise<QuotaSnapshot> {
  const core = 'codex' as const;
  const now = deps.now?.() ?? new Date();
  const baseDir = join(codexHome(deps.env, deps.homeDir ?? homedir()), 'sessions');
  const file = await findLatestCodexSessionFile(baseDir);
  if (!file) {
    return {
      core,
      state: 'unknown',
      reason: 'no Codex session files found under $CODEX_HOME/sessions',
    };
  }
  // `readAt` is the DATA's age, not the read's: a week-old session file means a
  // week-old window, so the view must say "read 7d ago" rather than "just now"
  // and must not trust an expired window. Fall back to now when mtime is unknown.
  let dataAt = now;
  try {
    dataAt = new Date((await stat(file)).mtimeMs);
  } catch {
    // file vanished between the listing and the stat — keep `now`
  }
  let text: string;
  try {
    text = await readTail(file, TAIL_BYTES);
  } catch {
    return { core, state: 'unknown', reason: 'the newest Codex session file could not be read' };
  }
  const limits = readCodexRateLimitsFrom(text);
  if (limits === null) {
    return {
      core,
      state: 'unknown',
      reason: 'the newest Codex session has no rate-limit data yet',
    };
  }
  const windows = parseCodexRateLimits(limits);
  if (windows.length === 0) {
    return {
      core,
      state: 'unknown',
      reason: 'the newest Codex session reported no usable quota window',
    };
  }
  return { core, state: 'ok', windows, source: SOURCE, readAt: dataAt.toISOString() };
}

/** The `QuotaReader` the service registers for Codex. */
export function codexQuotaReader(deps: CodexQuotaDeps = {}): QuotaReader {
  return { core: 'codex', read: () => readCodexQuota(deps) };
}
