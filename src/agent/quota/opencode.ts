import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { QuotaReader, QuotaSnapshot, QuotaWindow } from './types.js';

/**
 * OpenCode Go quota reader — the provider's own usage endpoint (`arch:AC-29`).
 *
 * `GET https://opencode.ai/zen/go/v1/usage` reports the account's rolling,
 * weekly and monthly subscription windows. It spends no model request and
 * reports no dollar amounts; the request reuses the Go API key the core CLI
 * already stores (`OPENCODE_API_KEY`, else the auth file's `opencode-go` entry,
 * then `opencode`). Live-verified on 2026-10-21.
 *
 * The launch path never calls this: `QuotaService` refreshes it on its own
 * interval and the launch warning reads the cache. The key, the Authorization
 * header and the raw response body are never logged.
 */

const SOURCE = 'OpenCode Go usage API';
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const REQUEST_TIMEOUT_MS = 5_000;

/** The auth-file entry order: the Go key first, the plain provider second. */
const AUTH_ENTRIES = ['opencode-go', 'opencode'] as const;

/** Wire window key -> the label the UI shows. */
const USAGE_WINDOWS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['rolling', '5-hour'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
];

/** A server message is capped so a hostile/oversized body cannot flood the UI. */
const MAX_ERROR_MESSAGE = 200;

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

/**
 * The default auth file: `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`.
 * opencode2 lives under karst's isolated store instead, so the host injects
 * that path explicitly (`arch:AC-27`).
 */
export function opencodeAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_DATA_HOME;
  const base = typeof xdg === 'string' && xdg.length > 0 ? xdg : join(home, '.local', 'share');
  return join(base, 'opencode', 'auth.json');
}

function entryKey(entry: unknown): string | null {
  const record = asRecord(entry);
  const key = record?.['key'];
  return typeof key === 'string' && key.trim().length > 0 ? key.trim() : null;
}

/**
 * The Go key: `OPENCODE_API_KEY` first, else `opencode-go`/`opencode` from the
 * auth file. Null means there is nothing to call the endpoint with — never a
 * reason to ask the user for a new secret.
 */
export async function resolveOpencodeKey(
  authPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const fromEnv = env.OPENCODE_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  let raw: string;
  try {
    raw = await readFile(authPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const auth = asRecord(parsed);
  if (!auth) return null;
  for (const name of AUTH_ENTRIES) {
    const key = entryKey(auth[name]);
    if (key !== null) return key;
  }
  return null;
}

/**
 * Map a usage payload to windows. Accepts the wrapped `{ usage: { ... } }`
 * shape and the bare object; a window without a numeric `percent` is skipped
 * (never coerced to 0), and a missing `monthly` simply yields two windows.
 */
export function parseOpencodeUsage(raw: unknown): QuotaWindow[] {
  const body = asRecord(raw);
  if (!body) return [];
  const usage = asRecord(body['usage']) ?? body;
  const windows: QuotaWindow[] = [];
  for (const [key, label] of USAGE_WINDOWS) {
    const win = asRecord(usage[key]);
    if (!win) continue;
    const percent = num(win['percent']);
    if (percent === null) continue;
    windows.push({
      label,
      usedPct: Math.max(0, Math.min(100, percent)),
      resetsAt: resetsAtIso(win['resetsAt'] ?? win['resets_at']),
    });
  }
  return windows;
}

/** The server's own `error.message` (or top-level `message`), capped. */
export function serverErrorMessage(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const body = asRecord(parsed);
  const message = asRecord(body?.['error'])?.['message'] ?? body?.['message'];
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_ERROR_MESSAGE);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface OpencodeQuotaDeps {
  /** Which core this reader serves; both share the account-wide meters. */
  core: 'opencode' | 'opencode2';
  /** Auth file to read when `OPENCODE_API_KEY` is unset. */
  authPath?: string;
  /** Injected for tests; never a retry — the 5-minute poll is the retry. */
  fetchImpl?: typeof fetch;
  /** Injected clock — a successful read stamps `readAt` from it. */
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** Read OpenCode Go's subscription windows. Async; no key means unknown. */
export async function readOpencodeQuota(deps: OpencodeQuotaDeps): Promise<QuotaSnapshot> {
  const core = deps.core;
  const env = deps.env ?? process.env;
  const authPath =
    deps.authPath ?? opencodeAuthPath(env, deps.homeDir ?? homedir());
  const key = await resolveOpencodeKey(authPath, env);
  if (key === null) {
    return {
      core,
      state: 'unknown',
      reason: `no OpenCode Go key in ${authPath}`,
    };
  }
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(USAGE_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${key}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { core, state: 'unknown', reason: `usage request failed: ${errorText(err)}` };
  }
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    // An unreadable body still leaves the status as the useful signal below.
  }
  if (response.status === 401 || response.status === 403) {
    const message = serverErrorMessage(raw);
    const suffix = message === null ? '' : ` (${message})`;
    return {
      core,
      state: 'unknown',
      reason: `OpenCode Go key rejected — create a new key in OpenCode Console${suffix}`,
    };
  }
  if (response.status === 404) {
    return { core, state: 'unknown', reason: 'this OpenCode account has no Go plan' };
  }
  if (!response.ok) {
    return {
      core,
      state: 'unknown',
      reason: `usage request failed: HTTP ${response.status}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { core, state: 'unknown', reason: 'usage request failed: invalid JSON response' };
  }
  const windows = parseOpencodeUsage(parsed);
  if (windows.length === 0) {
    return {
      core,
      state: 'unknown',
      reason: 'the usage response carried no usable window',
    };
  }
  const readAt = (deps.now?.() ?? new Date()).toISOString();
  return { core, state: 'ok', windows, source: SOURCE, readAt };
}

/** The shared `QuotaReader` factory for the opencode and opencode2 cores. */
export function opencodeQuotaReader(deps: OpencodeQuotaDeps): QuotaReader {
  return { core: deps.core, read: () => readOpencodeQuota(deps) };
}
