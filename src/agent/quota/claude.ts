import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ClaudeUsageClient, type ClaudeUsageApiDeps } from './claudeUsage.js';
import type { QuotaKnown, QuotaReader, QuotaSnapshot, QuotaWindow } from './types.js';

/**
 * Claude quota reader — the statusline telemetry payload (`arch:AC-29`) with an
 * OPT-IN OAuth usage API fallback (D185).
 *
 * Claude Code delivers runtime stats (including `rate_limits`: the 5-hour and
 * 7-day windows) on stdin to a configured `statusLine` command. A karst-managed
 * statusline wrapper caches that payload to a local JSON file, and this reader
 * reads the cache first — local, live and credential-free.
 *
 * Only when the cache is MISSING or STALE and `quota.claudeOauthUsageApi` is ON
 * does it fall back to `claudeUsage.ts` (the OAuth usage endpoint). The consent
 * check happens on every read, so toggling the setting applies without a
 * reload. Every API failure keeps the last good value (cache or an earlier API
 * snapshot) or reports `unknown` with the reason — never an error, never a
 * fabricated 0%.
 */

const SOURCE = 'Claude statusline telemetry';
const API_SOURCE = 'Claude OAuth usage API';
const RELATIVE_CACHE = join('cache', 'quota.json');

/**
 * How old the statusline cache may be before the API fallback may answer. It
 * mirrors the QuotaService's poll interval: a cache younger than one poll is
 * this cycle's data, so no network call is made.
 */
export const CLAUDE_CACHE_FRESH_MS = 5 * 60_000;

/** The Claude config root: `CLAUDE_CONFIG_DIR` override, else `<home>/.claude`. */
export function claudeConfigDir(env?: NodeJS.ProcessEnv, home: string = homedir()): string {
  const override = env?.CLAUDE_CONFIG_DIR;
  return typeof override === 'string' && override.length > 0 ? override : join(home, '.claude');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A reset stamp that may be Unix seconds (number) or an ISO string. */
function resetsAtIso(value: unknown): string | null {
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const seconds = num(value);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: '7-day',
};

/**
 * Map one statusline payload's `rate_limits` to windows. A window whose
 * `used_percentage` is not a number is skipped (never coerced to 0).
 */
export function parseClaudeRateLimits(raw: unknown): QuotaWindow[] {
  const payload = asRecord(raw);
  const limits = asRecord(payload?.['rate_limits']);
  if (!limits) return [];
  const windows: QuotaWindow[] = [];
  for (const [key, label] of Object.entries(CLAUDE_WINDOW_LABELS)) {
    const win = asRecord(limits[key]);
    if (!win) continue;
    const used = num(win['used_percentage']);
    if (used === null) continue;
    windows.push({
      label,
      usedPct: Math.max(0, Math.min(100, used)),
      resetsAt: resetsAtIso(win['resets_at']),
    });
  }
  return windows;
}

export interface ClaudeQuotaDeps {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /**
   * The opt-in OAuth usage API fallback. Absent (or its `enabled()` false)
   * keeps the reader cache-only, exactly as before D185.
   */
  usageApi?: ClaudeUsageApiDeps;
  /** Override the cache freshness window (tests). */
  cacheFreshMs?: number;
}

/** The statusline cache plus the age the freshness check needs. */
interface CacheRead {
  snapshot: QuotaSnapshot;
  /** Epoch ms of the cache write, or null when the file is absent/unstattable. */
  mtimeMs: number | null;
}

/**
 * Read the D183 statusline cache. `readAt` is the DATA's age, not the read's:
 * the cache is only rewritten when a Claude session runs, so a stale cache must
 * read as stale — an expired window must not drive the amber badge or the
 * launch warning.
 */
async function readStatuslineCache(deps: ClaudeQuotaDeps, now: Date): Promise<CacheRead> {
  const core = 'claude' as const;
  const cachePath = join(claudeConfigDir(deps.env, deps.homeDir ?? homedir()), RELATIVE_CACHE);
  let raw: string;
  try {
    raw = await readFile(cachePath, 'utf8');
  } catch {
    return {
      snapshot: {
        core,
        state: 'unknown',
        reason: `no Claude statusline quota cache (${cachePath})`,
      },
      mtimeMs: null,
    };
  }
  let dataAt = now;
  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await stat(cachePath)).mtimeMs;
    dataAt = new Date(mtimeMs);
  } catch {
    // vanished between the read and the stat — keep `now`
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      snapshot: { core, state: 'unknown', reason: 'the Claude quota cache could not be parsed' },
      mtimeMs,
    };
  }
  const windows = parseClaudeRateLimits(parsed);
  if (windows.length === 0) {
    return {
      snapshot: {
        core,
        state: 'unknown',
        reason: 'the Claude quota cache carries no rate-limit windows',
      },
      mtimeMs,
    };
  }
  return {
    snapshot: { core, state: 'ok', windows, source: SOURCE, readAt: dataAt.toISOString() },
    mtimeMs,
  };
}

/**
 * Build the reader body. State is CLOSED OVER so the service's factory keeps the
 * last good snapshot and the usage client's 429 backoff across polls; a plain
 * `readClaudeQuota()` call starts clean.
 */
function createClaudeQuotaRead(deps: ClaudeQuotaDeps): () => Promise<QuotaSnapshot> {
  const now = deps.now ?? (() => new Date());
  const usageApi = deps.usageApi;
  const client =
    usageApi === undefined
      ? undefined
      : new ClaudeUsageClient({
          ...usageApi,
          configDir: claudeConfigDir(deps.env, deps.homeDir ?? homedir()),
          now,
        });
  let lastGood: QuotaKnown | undefined;

  return async (): Promise<QuotaSnapshot> => {
    const at = now();
    const cache = await readStatuslineCache(deps, at);
    const fresh =
      cache.mtimeMs !== null &&
      at.getTime() - cache.mtimeMs <= (deps.cacheFreshMs ?? CLAUDE_CACHE_FRESH_MS);
    if (
      client === undefined ||
      usageApi?.enabled() !== true ||
      (cache.snapshot.state === 'ok' && fresh)
    ) {
      if (cache.snapshot.state === 'ok') lastGood = cache.snapshot;
      return cache.snapshot;
    }

    const result = await client.read();
    if (result.state === 'ok') {
      lastGood = {
        core: 'claude',
        state: 'ok',
        windows: result.windows,
        source: API_SOURCE,
        readAt: at.toISOString(),
      };
      return lastGood;
    }
    // A failed call never blanks a value we already showed: the statusline
    // cache wins (it is still provider data), then the last API/cache snapshot.
    return cache.snapshot.state === 'ok'
      ? cache.snapshot
      : (lastGood ?? { core: 'claude', state: 'unknown', reason: result.reason });
  };
}

/**
 * Read Claude quota once: the statusline cache first, the opt-in API when the
 * cache is missing/stale. Async: this runs on the extension host's event loop,
 * so no synchronous file I/O.
 */
export async function readClaudeQuota(deps: ClaudeQuotaDeps = {}): Promise<QuotaSnapshot> {
  return createClaudeQuotaRead(deps)();
}

/** The `QuotaReader` the service registers for Claude. */
export function claudeQuotaReader(deps: ClaudeQuotaDeps = {}): QuotaReader {
  const read = createClaudeQuotaRead(deps);
  return { core: 'claude', read: () => read() };
}
