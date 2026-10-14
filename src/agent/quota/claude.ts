import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { QuotaReader, QuotaSnapshot, QuotaWindow } from './types.js';

/**
 * Claude quota reader — the statusline telemetry payload (`arch:AC-29`).
 *
 * Claude Code delivers runtime stats (including `rate_limits`: the 5-hour and
 * 7-day windows) on stdin to a configured `statusLine` command. A karst-managed
 * statusline wrapper caches that payload to a local JSON file, and this reader
 * reads the cache. Zero model requests; no credentials are read here.
 *
 * The verdict is deliberately `partial` (`arch:AC-29`): with no cache (no
 * Claude session has run since the wrapper was configured) the core reads as
 * `unknown`, never as 0%.
 */

const SOURCE = 'Claude statusline telemetry';
const RELATIVE_CACHE = join('cache', 'quota.json');

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
}

/**
 * Read Claude quota from the cached statusline payload, if present. Async: this
 * runs on the extension host's event loop, so no synchronous file I/O.
 */
export async function readClaudeQuota(deps: ClaudeQuotaDeps = {}): Promise<QuotaSnapshot> {
  const core = 'claude' as const;
  const now = deps.now?.() ?? new Date();
  const cachePath = join(claudeConfigDir(deps.env, deps.homeDir ?? homedir()), RELATIVE_CACHE);
  let raw: string;
  try {
    raw = await readFile(cachePath, 'utf8');
  } catch {
    return {
      core,
      state: 'unknown',
      reason: `no Claude statusline quota cache (${cachePath})`,
    };
  }
  // `readAt` is the DATA's age, not the read's: the cache is only rewritten when
  // a Claude session runs, so a stale cache must read as stale — an expired
  // window must not drive the amber badge or the launch warning.
  let dataAt = now;
  try {
    dataAt = new Date((await stat(cachePath)).mtimeMs);
  } catch {
    // vanished between the read and the stat — keep `now`
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { core, state: 'unknown', reason: 'the Claude quota cache could not be parsed' };
  }
  const windows = parseClaudeRateLimits(parsed);
  if (windows.length === 0) {
    return {
      core,
      state: 'unknown',
      reason: 'the Claude quota cache carries no rate-limit windows',
    };
  }
  return { core, state: 'ok', windows, source: SOURCE, readAt: dataAt.toISOString() };
}

/** The `QuotaReader` the service registers for Claude. */
export function claudeQuotaReader(deps: ClaudeQuotaDeps = {}): QuotaReader {
  return { core: 'claude', read: () => readClaudeQuota(deps) };
}
