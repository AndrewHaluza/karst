import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { accountLaunchFor, accountReaderEnv } from '../accounts/registry.js';
import { resolveAgyAppDataDir } from '../agyConversationWatch.js';
import {
  ANTIGRAVITY_NOT_RUNNING_REASON,
  ANTIGRAVITY_UNRESPONSIVE_REASON,
  discoverAntigravityServer,
  type DirLister,
  type FileReader,
  type PortLister,
  type ProcessLister,
} from './antigravityDiscovery.js';
import type { QuotaKnown, QuotaReader, QuotaSnapshot, QuotaWindow } from './types.js';

export { ANTIGRAVITY_NOT_RUNNING_REASON, ANTIGRAVITY_UNRESPONSIVE_REASON };

/**
 * Antigravity quota reader — Language Server Connect RPC endpoint (`arch:AC-29`).
 *
 * Antigravity exposes a loopback Connect RPC service during active CLI sessions.
 * Karst queries:
 * 1. `POST /exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`
 *    for 5h / weekly multi-group rate-limit buckets.
 * 2. `POST /exa.language_server_pb.LanguageServerService/GetUserStatus`
 *    for user subscription tier and monthly plan credits.
 * Both endpoints use `Connect-Protocol-Version: 1` and `x-codeium-csrf-token`, and
 * `RetrieveUserQuotaSummary` asks for `forceRefresh: true`. Zero model request spend.
 *
 * When no language server answers (CLI-only sessions run it in-process), the reader
 * runs `agy -p "/usage" --output-format json` for the active account — zero model
 * turns — before falling back to the cache.
 *
 * Tier-aware filtering:
 * - Free Tier: Shows only active Gemini rate limits (5-hour & Weekly). Suppresses paid-only pools.
 * - Paid Tiers (Pro/Ultra): Shows 5-hour, Weekly, separated Claude/GPT (Weekly), Argon (Weekly).
 * - Suppresses any bucket with `disabled: true`.
 * - Surfaces detected tier name in header source: "Antigravity Language Server (Google AI Pro)" / "(Free Tier)".
 *
 * Offline resilience:
 * Live snapshots are cached to `<appDataDir>/cache/quota.json` via atomic write
 * (temp file + renameSync). Fresh reads within 24h TTL return the cached QuotaSnapshot
 * with preserved `readAt` and `source`.
 *
 * In accordance with arch:AC-29, the CSRF token is held in-memory only and never
 * written to cache, logs, or store.
 */

export const ANTIGRAVITY_QUOTA_SOURCE = 'Antigravity Language Server';
export const ANTIGRAVITY_CLI_QUOTA_SOURCE = 'Antigravity CLI (/usage)';
export const ANTIGRAVITY_CACHE_TTL_MS = 24 * 60 * 60_000; // 24 hours
export const ANTIGRAVITY_TIMEOUT_MS = 2000;
export const ANTIGRAVITY_CLI_TIMEOUT_MS = 10_000;
export const ANTIGRAVITY_RELATIVE_CACHE = join('cache', 'quota.json');

export function antigravityQuotaCachePath(appDataDir: string): string {
  return join(appDataDir, ANTIGRAVITY_RELATIVE_CACHE);
}

/** Headless `agy -p "/usage" --output-format json` runner (injected in unit tests). */
export type AntigravityCliUsageRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<string | null>;

const execFileAsync = promisify(execFile);

/** Run the CLI usage command; any failure (ENOENT, timeout, non-zero exit) is a quiet null. */
async function defaultRunCliUsage(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return typeof stdout === 'string' ? stdout : null;
  } catch {
    return null;
  }
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

export interface DetectedTier {
  tier: 'free' | 'pro' | 'ultra' | 'unknown';
  tierName: string | null;
  isPaid: boolean;
}

/**
 * Detect user tier from GetUserStatus response via userTier.id or planInfo.teamsTier.
 */
export function detectAntigravityTier(raw: unknown): DetectedTier {
  const root = asRecord(raw);
  if (!root) {
    return { tier: 'unknown', tierName: null, isPaid: true };
  }

  const userStatus = asRecord(root.userStatus);
  const planStatus = asRecord(userStatus?.planStatus ?? root.planStatus);
  const planInfo = asRecord(planStatus?.planInfo ?? userStatus?.planInfo ?? root.planInfo);
  const userTier = asRecord(userStatus?.userTier ?? root.userTier);

  const tierId = typeof userTier?.id === 'string' ? userTier.id.toLowerCase() : '';
  const teamsTier = typeof planInfo?.teamsTier === 'string' ? planInfo.teamsTier.toUpperCase() : '';

  if (tierId.includes('ultra') || teamsTier.includes('ULTRA')) {
    return { tier: 'ultra', tierName: 'Google AI Ultra', isPaid: true };
  }
  if (tierId.includes('pro') || teamsTier.includes('PRO')) {
    return { tier: 'pro', tierName: 'Google AI Pro', isPaid: true };
  }
  if (tierId.includes('free') || teamsTier.includes('FREE')) {
    return { tier: 'free', tierName: 'Free Tier', isPaid: false };
  }

  return { tier: 'unknown', tierName: null, isPaid: true };
}

export function antigravitySourceWithTier(tierName: string | null): string {
  if (typeof tierName === 'string' && tierName.length > 0) {
    return `${ANTIGRAVITY_QUOTA_SOURCE} (${tierName})`;
  }
  return ANTIGRAVITY_QUOTA_SOURCE;
}

export function windowDurationMinutes(label: string): number {
  const lower = label.toLowerCase();
  if (lower.includes('5-hour') || lower.includes('5h')) {
    return 300;
  }
  if (lower.includes('weekly') || lower.includes('7-day')) {
    return 10080;
  }
  return Number.POSITIVE_INFINITY;
}

export function resolveBucketLabel(
  bucket: Record<string, unknown>,
  group?: Record<string, unknown> | null,
): string {
  const rawBucketId =
    typeof bucket.bucketId === 'string' && bucket.bucketId.length > 0
      ? bucket.bucketId
      : typeof bucket.id === 'string' && bucket.id.length > 0
        ? bucket.id
        : '';
  const bucketId = rawBucketId.toLowerCase();
  const window = typeof bucket.window === 'string' ? bucket.window.toLowerCase() : '';
  const groupName = typeof group?.displayName === 'string'
    ? group.displayName.toLowerCase()
    : typeof group?.name === 'string'
      ? group.name.toLowerCase()
      : '';
  const explicitLabel = typeof bucket.label === 'string' && bucket.label.length > 0
    ? bucket.label
    : typeof bucket.displayName === 'string' && bucket.displayName.length > 0
      ? bucket.displayName
      : typeof bucket.name === 'string' && bucket.name.length > 0
        ? bucket.name
        : '';
  const lowerLabel = explicitLabel.toLowerCase();

  const isArgon = groupName.includes('argon') || bucketId.includes('argon');
  const isGemini = (groupName.includes('gemini') || bucketId.includes('gemini')) && !isArgon;
  const is3p = groupName.includes('claude') || groupName.includes('gpt') || groupName.includes('3p') ||
               bucketId.includes('claude') || bucketId.includes('gpt') || bucketId.includes('3p');

  const is5h =
    window === '5h' ||
    window === '5-hour' ||
    bucketId.includes('5h') ||
    bucketId.includes('5-hour') ||
    lowerLabel.includes('5h') ||
    lowerLabel.includes('5-hour');
  const isWeekly =
    window === 'weekly' ||
    window === '7-day' ||
    bucketId.includes('weekly') ||
    bucketId.includes('7-day') ||
    lowerLabel.includes('weekly') ||
    lowerLabel.includes('7-day');

  if (isGemini) {
    if (is5h) return '5-hour';
    if (isWeekly) return 'Weekly';
  }

  if (isArgon) {
    if (isWeekly) return 'Argon (Weekly)';
    if (is5h) return 'Argon (5-hour)';
  }

  if (is3p) {
    if (isWeekly) return 'Claude/GPT (Weekly)';
    if (is5h) return 'Claude/GPT (5-hour)';
  }

  if (explicitLabel.length > 0) return explicitLabel;
  if (rawBucketId.length > 0) return rawBucketId;
  return 'Model';
}

/**
 * Parse RetrieveUserQuotaSummary and GetUserStatus responses into quota windows.
 */
export function parseAntigravityWindows(summaryRaw: unknown, statusRaw?: unknown): QuotaWindow[] {
  const summaryRoot = asRecord(summaryRaw);
  const statusRoot = asRecord(statusRaw ?? summaryRaw);
  if (!summaryRoot && !statusRoot) return [];

  const tierContext = detectAntigravityTier(statusRaw ?? summaryRaw);
  const isPaid = tierContext.isPaid;
  const windows: QuotaWindow[] = [];

  // 1. Multi-group rate-limit buckets from RetrieveUserQuotaSummary or `agy -p "/usage"` (command.data)
  const commandObj = asRecord(summaryRoot?.command);
  const summaryData = asRecord(
    commandObj?.data ?? summaryRoot?.response ?? summaryRoot?.userQuotaSummary ?? summaryRoot,
  );
  const groups = Array.isArray(summaryData?.groups) ? summaryData.groups : null;

  if (groups !== null) {
    for (const groupItem of groups) {
      const group = asRecord(groupItem);
      if (!group) continue;
      const buckets = Array.isArray(group.buckets) ? group.buckets : [];
      for (const bucketItem of buckets) {
        const bucket = asRecord(bucketItem);
        if (!bucket) continue;
        if (bucket.disabled === true) continue;

        const remainingFraction = num(bucket.remainingFraction) ?? num(bucket.remaining_fraction);
        if (remainingFraction === null) continue;

        const usedPct = Math.round((1 - remainingFraction) * 100);
        const resetsAt =
          typeof bucket.resetTime === 'string' && bucket.resetTime.length > 0
            ? bucket.resetTime
            : typeof bucket.reset_time === 'string' && bucket.reset_time.length > 0
              ? bucket.reset_time
              : null;
        const label = resolveBucketLabel(bucket, group);

        if (!isPaid) {
          if (label === '5-hour' || label === 'Weekly') {
            windows.push({ label, usedPct, resetsAt });
          }
        } else {
          windows.push({ label, usedPct, resetsAt });
        }
      }
    }
  }

  // 2. Fallback for legacy single-call GetUserStatus payloads without groups
  if (groups === null && statusRoot) {
    const userStatus = asRecord(statusRoot.userStatus);
    const cascadeData = asRecord(userStatus?.cascadeModelConfigData ?? statusRoot.cascadeModelConfigData);
    const modelConfigs =
      cascadeData?.clientModelConfigs ??
      userStatus?.clientModelConfigs ??
      statusRoot.clientModelConfigs;

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

        if (!isPaid) {
          if (label === '5-hour' || label === 'Weekly') {
            windows.push({ label, usedPct, resetsAt });
          }
        } else {
          windows.push({ label, usedPct, resetsAt });
        }
      }
    }
  }

  windows.sort((a, b) => windowDurationMinutes(a.label) - windowDurationMinutes(b.label));

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

export interface LiveQuotaPayload {
  windows: QuotaWindow[];
  source: string;
}

async function callConnectRpc(
  address: string,
  methodName: string,
  csrfToken: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  body = '{}',
): Promise<unknown> {
  const url = `http://${address}/exa.language_server_pb.LanguageServerService/${methodName}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Connect-Protocol-Version': '1',
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': csrfToken,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Language server HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchLiveQuota(
  address: string,
  csrfToken: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<LiveQuotaPayload> {
  const [summaryBody, statusBody] = await Promise.all([
    // `forceRefresh: true` mirrors `agy /usage`: it bypasses the language server's own cache.
    callConnectRpc(
      address,
      'RetrieveUserQuotaSummary',
      csrfToken,
      fetchFn,
      timeoutMs,
      '{"forceRefresh":true}',
    ),
    callConnectRpc(address, 'GetUserStatus', csrfToken, fetchFn, timeoutMs),
  ]);

  const detectedTier = detectAntigravityTier(statusBody);
  const source = antigravitySourceWithTier(detectedTier.tierName);
  const windows = parseAntigravityWindows(summaryBody, statusBody);

  if (windows.length === 0) {
    throw new Error('No quota windows in language server response');
  }

  return { windows, source };
}

export interface AntigravityQuotaReaderDeps {
  appDataDir?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  timeoutMs?: number;
  listProcesses?: ProcessLister;
  listPorts?: PortLister;
  readFile?: FileReader;
  listDir?: DirLister;
  runCliUsage?: AntigravityCliUsageRunner;
  cliTimeoutMs?: number;
}

export function antigravityQuotaReader(deps: AntigravityQuotaReaderDeps = {}): QuotaReader {
  return {
    core: 'antigravity',
    async read(): Promise<QuotaSnapshot> {
      const home = deps.homeDir ?? homedir();
      // `accountReaderEnv()` resolves the home variable of the ACTIVE account at
      // read time, so a `setActive` reaches this long-lived reader (`arch:AC-55`).
      const env = deps.env ?? accountReaderEnv();
      const nowFn = deps.now ?? (() => new Date());
      const fetchFn = deps.fetchImpl ?? fetch;
      // `accountReaderEnv()` traps only `get`, so materialize the data dir here:
      // a spread would miss a key that is not already in `process.env`.
      const envDataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
      // A named folder account (or an operator's override) owns this data dir, so
      // discovery reads ONLY its records: the default `~/.gemini/...` folders and
      // the machine-wide process scan belong to no named account and would answer
      // with another account's quota (`arch:AC-48`). The CLI fallback below is
      // account-scoped and covers a folder with no answering language server.
      const dataDirOnly =
        typeof envDataDir === 'string' && envDataDir.length > 0 ? true : false;
      const appDataDir = deps.appDataDir ?? resolveAgyAppDataDir(env, home);
      const cachePath = antigravityQuotaCachePath(appDataDir);
      const ttlMs = deps.cacheTtlMs ?? ANTIGRAVITY_CACHE_TTL_MS;
      const timeoutMs = deps.timeoutMs ?? ANTIGRAVITY_TIMEOUT_MS;
      const runCliUsageFn = deps.runCliUsage ?? defaultRunCliUsage;
      const cliTimeoutMs = deps.cliTimeoutMs ?? ANTIGRAVITY_CLI_TIMEOUT_MS;

      const discovery = await discoverAntigravityServer({
        env,
        homeDir: home,
        appDataDir,
        dataDirOnly,
        fetchImpl: fetchFn,
        timeoutMs,
        listProcesses: deps.listProcesses,
        listPorts: deps.listPorts,
        readFile: deps.readFile,
        listDir: deps.listDir,
      });

      let liveError: string | null = null;
      if ('address' in discovery && 'csrfToken' in discovery && discovery.address && discovery.csrfToken) {
        try {
          const { windows, source } = await fetchLiveQuota(
            discovery.address,
            discovery.csrfToken,
            fetchFn,
            timeoutMs,
          );
          const snapshot: QuotaKnown = {
            core: 'antigravity',
            state: 'ok',
            windows,
            source,
            readAt: nowFn().toISOString(),
          };
          writeCache(cachePath, snapshot);
          return snapshot;
        } catch {
          liveError = ANTIGRAVITY_UNRESPONSIVE_REASON;
        }
      } else {
        liveError = discovery.reason ?? ANTIGRAVITY_NOT_RUNNING_REASON;
      }

      // Headless fallback: `agy -p "/usage" --output-format json` spends zero model
      // turns and reads the ACTIVE account's quota (`arch:AC-48`, `arch:AC-55`).
      try {
        const launch = accountLaunchFor('antigravity', 'agy');
        const cliEnv: NodeJS.ProcessEnv = {
          ...env,
          ...(envDataDir ? { ANTIGRAVITY_EXECUTABLE_DATA_DIR: envDataDir } : {}),
          ...launch.env,
          ...(deps.appDataDir ? { ANTIGRAVITY_EXECUTABLE_DATA_DIR: deps.appDataDir } : {}),
        };
        const stdout = await runCliUsageFn(
          launch.binary,
          [...launch.args, '-p', '/usage', '--output-format', 'json'],
          cliEnv,
          cliTimeoutMs,
        );
        if (typeof stdout === 'string' && stdout.trim().length > 0) {
          const windows = parseAntigravityWindows(JSON.parse(stdout) as unknown);
          if (windows.length > 0) {
            const snapshot: QuotaKnown = {
              core: 'antigravity',
              state: 'ok',
              windows,
              source: ANTIGRAVITY_CLI_QUOTA_SOURCE,
              readAt: nowFn().toISOString(),
            };
            writeCache(cachePath, snapshot);
            return snapshot;
          }
        }
      } catch {
        // A CLI failure never leaks a token or blocks the cache fallback below.
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
