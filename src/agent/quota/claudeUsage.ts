import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import type { QuotaWindow } from './types.js';

/**
 * The opt-in Claude subscription usage API (`arch:AC-29`, D185) — the FALLBACK
 * behind `quota.claudeOauthUsageApi` when `claude.ts`'s statusline cache is
 * missing or stale.
 *
 * `GET https://api.anthropic.com/api/oauth/usage` is the endpoint Claude Code
 * itself calls (binary-verified in 2.1.300). It authorizes with the OAuth access
 * token the CLI already stored — the macOS Keychain item
 * `Claude Code-credentials` (plus per-config-dir suffixed variants) or, on
 * Linux, `<CLAUDE_CONFIG_DIR>/.credentials.json`. The token is read into memory,
 * used for this one request, and dropped: it is NEVER logged, stored, refreshed
 * or handed to the UI. karst must not drive the CLI's auth lifecycle, so an
 * expired/401 token degrades to the cache (or unknown), never a refresh.
 *
 * Every failure is a typed `unknown` reason — no token, 401, 429 (honoring
 * `Retry-After`), network down, a schema change — never a thrown error.
 */

/** The usage endpoint Claude Code 2.1.300 calls; `skip_spend=1` omits $ blocks. */
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1';

/** The OAuth beta header Claude Code sends for a subscription token. */
const OAUTH_BETA = 'oauth-2025-04-20';

/** A hung request must not pin a poll; the launch path never awaits it anyway. */
export const CLAUDE_USAGE_TIMEOUT_MS = 5_000;

/** The 429 fallback when the provider sends no (or an unparseable) `Retry-After`. */
export const DEFAULT_RETRY_AFTER_MS = 5 * 60_000;

/** The macOS Keychain service holding the CLI's OAuth credentials. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Fetch signature — the global `fetch` type, injected for testability. */
export type FetchLike = typeof fetch;

/** Run `security find-generic-password -w -s <service>`; null when absent. */
export type RunSecurity = (service: string) => Promise<string | null>;

/** A token lookup result: the access token, or a reason the caller renders. */
export type ClaudeTokenLookup =
  | { state: 'ok'; token: string }
  | { state: 'unknown'; reason: string };

/** One API read: the mapped windows, or an unknown reason (+ 429 backoff). */
export type ClaudeUsageResult =
  | { state: 'ok'; windows: QuotaWindow[] }
  | { state: 'unknown'; reason: string; retryAfterMs?: number };

/** The opt-in switch plus the injected seams (host-agnostic: no vscode here). */
export interface ClaudeUsageApiDeps {
  /** Live consent: read on every poll, so a Settings toggle applies without a reload. */
  enabled: () => boolean;
  /** Test seams; production uses `process.platform`, global `fetch` and `security`. */
  platform?: NodeJS.Platform;
  fetchFn?: FetchLike;
  runSecurity?: RunSecurity;
  timeoutMs?: number;
  debug?: (message: string) => void;
}

/** The fully resolved options one request needs (config dir and clock injected). */
export interface ClaudeUsageOptions extends ClaudeUsageApiDeps {
  configDir: string;
  now: () => Date;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `resetsAt` as epoch seconds (the API's shape), or an ISO string, to ISO. */
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

const USAGE_WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: '5-hour',
  seven_day: '7-day',
};

/**
 * Map the usage response's `five_hour` / `seven_day` windows. `utilization` is
 * 0–1 (x100 for the view's used-%), `resetsAt` epoch seconds. The sonnet/opus/
 * model-scoped blocks are deliberately ignored (this feature is only the two
 * subscription windows). A window with no numeric utilization is skipped —
 * never coerced to 0%.
 */
export function parseClaudeUsageWindows(raw: unknown): QuotaWindow[] {
  const body = asRecord(raw);
  if (!body) return [];
  const windows: QuotaWindow[] = [];
  for (const [key, label] of Object.entries(USAGE_WINDOW_LABELS)) {
    const win = asRecord(body[key]);
    if (!win) continue;
    const utilization = num(win['utilization']);
    if (utilization === null) continue;
    windows.push({
      label,
      // Round to one decimal: 0-1 x100 otherwise leaks float noise (0.07 -> 7.000000000000001).
      usedPct: Math.max(0, Math.min(100, Math.round(utilization * 1000) / 10)),
      resetsAt: resetsAtIso(win['resetsAt']),
    });
  }
  return windows;
}

/** An OAuth access token plus its expiry, parsed from the CLI's credential blob. */
export interface ClaudeCredentials {
  token: string;
  /** Epoch milliseconds, or null when the CLI recorded no expiry. */
  expiresAt: number | null;
}

/**
 * Parse the JSON blob Claude Code stores (Keychain output or `.credentials.json`):
 * `{ claudeAiOauth: { accessToken, expiresAt, … } }`. Never returns the refresh
 * token — karst has no use for it and must not drive the auth lifecycle.
 */
export function parseClaudeCredentials(raw: string): ClaudeCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (root === null) return null;
  const oauth = asRecord(root['claudeAiOauth']) ?? root;
  const token = oauth['accessToken'];
  if (typeof token !== 'string' || token.trim().length === 0) return null;
  return { token: token.trim(), expiresAt: num(oauth['expiresAt']) };
}

/** True when the CLI itself stamped the token expired (never refreshed here). */
function expired(credentials: ClaudeCredentials, now: Date): boolean {
  return (
    credentials.expiresAt !== null &&
    credentials.expiresAt > 0 &&
    credentials.expiresAt <= now.getTime()
  );
}

/**
 * The Keychain services to try, in order: the per-config-dir suffixed item
 * first when a custom `CLAUDE_CONFIG_DIR` is in play (that is the CLI's item for
 * this profile), then the default item. A lookup that misses falls through to
 * the next candidate; nothing is written.
 */
export function claudeKeychainServices(configDir: string): string[] {
  const name = basename(configDir);
  return name === '.claude'
    ? [CLAUDE_KEYCHAIN_SERVICE]
    : [`${CLAUDE_KEYCHAIN_SERVICE}-${name}`, CLAUDE_KEYCHAIN_SERVICE];
}

/** The real Keychain reader — async so a locked keychain never blocks the host. */
const execFileAsync = promisify(execFile);

export const runSecurityFindGenericPassword: RunSecurity = async (service) => {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-w', '-s', service],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    return stdout;
  } catch {
    // Absent item, locked keychain, or a refused prompt: just a miss. The error
    // is discarded so no captured output can reach a log.
    return null;
  }
};

/** Resolve the OAuth access token from the platform's credential store. */
export async function readClaudeOAuthToken(options: {
  configDir: string;
  now: Date;
  platform?: NodeJS.Platform;
  runSecurity?: RunSecurity;
}): Promise<ClaudeTokenLookup> {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    const run = options.runSecurity ?? runSecurityFindGenericPassword;
    for (const service of claudeKeychainServices(options.configDir)) {
      const raw = await run(service);
      if (raw === null) continue;
      const credentials = parseClaudeCredentials(raw);
      if (credentials === null) continue;
      if (expired(credentials, options.now)) {
        return { state: 'unknown', reason: 'the Claude OAuth token has expired' };
      }
      return { state: 'ok', token: credentials.token };
    }
    return { state: 'unknown', reason: 'no Claude OAuth token in the macOS Keychain' };
  }
  const credentialsPath = join(options.configDir, '.credentials.json');
  let raw: string;
  try {
    raw = await readFile(credentialsPath, 'utf8');
  } catch {
    return { state: 'unknown', reason: `no Claude credentials file (${credentialsPath})` };
  }
  const credentials = parseClaudeCredentials(raw);
  if (credentials === null) {
    return { state: 'unknown', reason: 'the Claude credentials file carries no OAuth token' };
  }
  if (expired(credentials, options.now)) {
    return { state: 'unknown', reason: 'the Claude OAuth token has expired' };
  }
  return { state: 'ok', token: credentials.token };
}

/**
 * `Retry-After` as milliseconds: delta-seconds or an HTTP date, with a bounded
 * fallback when the header is absent/unparseable.
 */
export function parseRetryAfterMs(header: string | null, now: Date): number {
  if (header !== null) {
    const trimmed = header.trim();
    const seconds = Number(trimmed);
    if (trimmed.length > 0 && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) return Math.max(0, at - now.getTime());
  }
  return DEFAULT_RETRY_AFTER_MS;
}

/**
 * One authenticated usage request. Never throws: every failure is an unknown
 * reason. The bearer token is used in the request header only and never copied
 * into a result, a reason or a debug line.
 */
export async function fetchClaudeUsage(options: ClaudeUsageOptions): Promise<ClaudeUsageResult> {
  const lookup = await readClaudeOAuthToken({
    configDir: options.configDir,
    now: options.now(),
    platform: options.platform,
    runSecurity: options.runSecurity,
  });
  if (lookup.state === 'unknown') return lookup;

  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(CLAUDE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${lookup.token}`,
        'anthropic-beta': OAUTH_BETA,
        accept: 'application/json',
        'user-agent': 'karst',
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS),
    });
  } catch {
    // The message may echo the URL/headers; keep it out of the reason.
    return { state: 'unknown', reason: 'the Claude usage API request failed' };
  }

  if (response.status === 401) {
    return { state: 'unknown', reason: 'the Claude usage API rejected the OAuth token (401)' };
  }
  if (response.status === 429) {
    return {
      state: 'unknown',
      reason: 'the Claude usage API is rate limited (429)',
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), options.now()),
    };
  }
  if (!response.ok) {
    return { state: 'unknown', reason: `the Claude usage API returned ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { state: 'unknown', reason: 'the Claude usage API returned an unparseable response' };
  }
  const windows = parseClaudeUsageWindows(body);
  if (windows.length === 0) {
    return { state: 'unknown', reason: 'the Claude usage API response carried no usable quota window' };
  }
  return { state: 'ok', windows };
}

/**
 * Stateful wrapper that honors a 429's `Retry-After` across polls: while the
 * provider's window is open, a read returns the rate-limit reason WITHOUT a
 * network call (the cache/last-good value still answers the UI).
 */
export class ClaudeUsageClient {
  private blockedUntil = 0;

  constructor(private readonly options: ClaudeUsageOptions) {}

  async read(): Promise<ClaudeUsageResult> {
    const now = this.options.now();
    if (now.getTime() < this.blockedUntil) {
      return { state: 'unknown', reason: 'the Claude usage API is still rate limited (429)' };
    }
    const result = await fetchClaudeUsage(this.options);
    if (result.state === 'unknown' && result.retryAfterMs !== undefined) {
      this.blockedUntil = now.getTime() + result.retryAfterMs;
    }
    if (result.state === 'unknown') {
      this.options.debug?.(`karst: Claude usage API unavailable: ${result.reason}`);
    }
    return result;
  }
}
