import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { resolveAgyAppDataDir } from '../agyConversationWatch.js';
import type { QuotaKnown, QuotaReader, QuotaSnapshot, QuotaWindow } from './types.js';

/**
 * Antigravity quota reader — Language Server Connect RPC endpoint (`arch:AC-29`).
 *
 * Antigravity exposes a loopback Connect RPC service during active CLI sessions.
 * Karst queries `POST /exa.language_server_pb.LanguageServerService/GetUserStatus`
 * with `Connect-Protocol-Version: 1` and `x-codeium-csrf-token`. Zero model request spend.
 *
 * Offline resilience:
 * Live snapshots are cached to `<appDataDir>/cache/quota.json` via atomic write
 * (temp file + renameSync). Fresh reads within 24h TTL return the cached QuotaSnapshot
 * with preserved `readAt`.
 *
 * In accordance with arch:AC-29, the CSRF token is held in-memory only and never
 * written to cache, logs, or store.
 */

export const ANTIGRAVITY_QUOTA_SOURCE = 'Antigravity Language Server';
export const ANTIGRAVITY_CACHE_TTL_MS = 24 * 60 * 60_000; // 24 hours
export const ANTIGRAVITY_TIMEOUT_MS = 2000;
export const ANTIGRAVITY_RELATIVE_CACHE = join('cache', 'quota.json');

export function antigravityQuotaCachePath(appDataDir: string): string {
  return join(appDataDir, ANTIGRAVITY_RELATIVE_CACHE);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function findNumber(sources: (Record<string, unknown> | null | undefined)[], key: string): number | null {
  for (const src of sources) {
    if (!src) continue;
    const n = num(src[key]);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Parse GetUserStatus response into Prompt Credits, Flow Credits, and model windows.
 */
export function parseAntigravityWindows(raw: unknown): QuotaWindow[] {
  const root = asRecord(raw);
  if (!root) return [];

  const windows: QuotaWindow[] = [];

  const userStatus = asRecord(root.userStatus);
  const planStatus = asRecord(userStatus?.planStatus ?? root.planStatus);
  const planInfo = asRecord(planStatus?.planInfo ?? userStatus?.planInfo ?? root.planInfo);
  const creditSources = [planInfo, planStatus, userStatus, root];

  // 1. Prompt Credits
  const monthlyPrompt = findNumber(creditSources, 'monthlyPromptCredits');
  const availPrompt = findNumber(creditSources, 'availablePromptCredits');
  if (monthlyPrompt !== null && availPrompt !== null && monthlyPrompt > 0) {
    const usedPct = Math.round(((monthlyPrompt - availPrompt) / monthlyPrompt) * 100);
    windows.push({
      label: 'Prompt Credits',
      usedPct,
      resetsAt: null,
    });
  }

  // 2. Flow Credits
  const monthlyFlow = findNumber(creditSources, 'monthlyFlowCredits');
  const availFlow = findNumber(creditSources, 'availableFlowCredits');
  if (monthlyFlow !== null && availFlow !== null && monthlyFlow > 0) {
    const usedPct = Math.round(((monthlyFlow - availFlow) / monthlyFlow) * 100);
    windows.push({
      label: 'Flow Credits',
      usedPct,
      resetsAt: null,
    });
  }

  // 3. Model Quota
  const cascadeData = asRecord(userStatus?.cascadeModelConfigData ?? root.cascadeModelConfigData);
  const modelConfigs =
    cascadeData?.clientModelConfigs ??
    userStatus?.clientModelConfigs ??
    root.clientModelConfigs;

  if (Array.isArray(modelConfigs)) {
    for (const item of modelConfigs) {
      const cfg = asRecord(item);
      if (!cfg) continue;
      const quotaInfo = asRecord(cfg.quotaInfo);
      if (!quotaInfo) continue;
      const remainingFraction = num(quotaInfo.remainingFraction);
      if (remainingFraction === null) continue;

      const usedPct = Math.round((1 - remainingFraction) * 100);
      const resetsAt =
        typeof quotaInfo.resetTime === 'string' && quotaInfo.resetTime.length > 0
          ? quotaInfo.resetTime
          : null;
      const label =
        typeof cfg.label === 'string' && cfg.label.length > 0
          ? cfg.label
          : typeof cfg.modelId === 'string' && cfg.modelId.length > 0
            ? cfg.modelId
            : 'Model';

      windows.push({ label, usedPct, resetsAt });
    }
  }

  return windows;
}

export function writeCache(cachePath: string, snapshot: QuotaKnown): void {
  try {
    const dir = dirname(cachePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${cachePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(snapshot));
    renameSync(tmpPath, cachePath);
  } catch {
    // Write failure must not blow up the live read
  }
}

export async function readCache(
  cachePath: string,
  nowMs: number,
  ttlMs: number,
): Promise<QuotaKnown | null> {
  try {
    const content = await readFile(cachePath, 'utf8');
    const data = JSON.parse(content) as unknown;
    const rec = asRecord(data);
    if (!rec || rec.core !== 'antigravity' || rec.state !== 'ok' || !Array.isArray(rec.windows)) {
      return null;
    }
    if (typeof rec.readAt !== 'string') return null;
    const readAtMs = new Date(rec.readAt).getTime();
    if (Number.isNaN(readAtMs)) return null;
    const ageMs = nowMs - readAtMs;
    if (ageMs < 0 || ageMs > ttlMs) return null;
    return {
      core: 'antigravity',
      state: 'ok',
      windows: rec.windows as QuotaWindow[],
      source: typeof rec.source === 'string' ? rec.source : ANTIGRAVITY_QUOTA_SOURCE,
      readAt: rec.readAt,
    };
  } catch {
    return null;
  }
}

async function fetchLiveQuota(
  address: string,
  csrfToken: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<QuotaWindow[]> {
  const url = `http://${address}/exa.language_server_pb.LanguageServerService/GetUserStatus`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Connect-Protocol-Version': '1',
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': csrfToken,
    },
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Language server HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  const windows = parseAntigravityWindows(body);
  if (windows.length === 0) {
    throw new Error('No quota windows in language server response');
  }
  return windows;
}

export interface AntigravityQuotaReaderDeps {
  appDataDir?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  timeoutMs?: number;
}

export function antigravityQuotaReader(deps: AntigravityQuotaReaderDeps = {}): QuotaReader {
  return {
    core: 'antigravity',
    async read(): Promise<QuotaSnapshot> {
      const home = deps.homeDir ?? homedir();
      const env = deps.env ?? process.env;
      const nowFn = deps.now ?? (() => new Date());
      const fetchFn = deps.fetchImpl ?? fetch;
      const appDataDir = deps.appDataDir ?? resolveAgyAppDataDir(env, home);
      const cachePath = antigravityQuotaCachePath(appDataDir);
      const ttlMs = deps.cacheTtlMs ?? ANTIGRAVITY_CACHE_TTL_MS;
      const timeoutMs = deps.timeoutMs ?? ANTIGRAVITY_TIMEOUT_MS;

      const address = env.ANTIGRAVITY_LS_ADDRESS;
      const csrf = env.ANTIGRAVITY_CSRF_TOKEN;

      let liveError: string | null = null;
      if (address && csrf) {
        try {
          const windows = await fetchLiveQuota(address, csrf, fetchFn, timeoutMs);
          const snapshot: QuotaKnown = {
            core: 'antigravity',
            state: 'ok',
            windows,
            source: ANTIGRAVITY_QUOTA_SOURCE,
            readAt: nowFn().toISOString(),
          };
          writeCache(cachePath, snapshot);
          return snapshot;
        } catch (err) {
          liveError = err instanceof Error ? err.message : String(err);
        }
      } else {
        liveError = !address
          ? 'ANTIGRAVITY_LS_ADDRESS is not set'
          : 'ANTIGRAVITY_CSRF_TOKEN is not set';
      }

      const cached = await readCache(cachePath, nowFn().getTime(), ttlMs);
      if (cached) {
        return cached;
      }

      return {
        core: 'antigravity',
        state: 'unknown',
        reason: liveError,
      };
    },
  };
}
