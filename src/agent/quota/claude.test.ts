import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigDir, claudeQuotaReader, parseClaudeRateLimits, readClaudeQuota } from './claude.js';
import type { ClaudeUsageApiDeps } from './claudeUsage.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'karst-claude-quota-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeCache(payload: unknown, configDir = join(home, '.claude')): void {
  const dir = join(configDir, 'cache');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'quota.json'), JSON.stringify(payload));
}

const STATUSLINE = {
  model: { display_name: 'Claude Sonnet' },
  rate_limits: {
    five_hour: { used_percentage: 34, resets_at: 1746540000 },
    seven_day: { used_percentage: 12, resets_at: 1746799200 },
  },
};

describe('claudeConfigDir', () => {
  it('honors CLAUDE_CONFIG_DIR, else <home>/.claude', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/custom' }, '/home/u')).toBe('/custom');
    expect(claudeConfigDir({}, '/home/u')).toBe('/home/u/.claude');
  });
});

describe('parseClaudeRateLimits', () => {
  it('maps the 5-hour and 7-day windows', () => {
    expect(parseClaudeRateLimits(STATUSLINE)).toEqual([
      { label: '5-hour', usedPct: 34, resetsAt: new Date(1746540000 * 1000).toISOString() },
      { label: '7-day', usedPct: 12, resetsAt: new Date(1746799200 * 1000).toISOString() },
    ]);
  });

  it('accepts an ISO reset stamp', () => {
    const windows = parseClaudeRateLimits({
      rate_limits: { five_hour: { used_percentage: 10, resets_at: '2026-01-02T00:00:00.000Z' } },
    });
    expect(windows[0]!.resetsAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('skips a window whose used_percentage is not a number', () => {
    expect(
      parseClaudeRateLimits({ rate_limits: { five_hour: { resets_at: 1 } } }),
    ).toEqual([]);
  });

  it('returns [] when rate_limits is absent', () => {
    expect(parseClaudeRateLimits({ model: {} })).toEqual([]);
  });
});

describe('readClaudeQuota', () => {
  it('reports unknown when no cache exists', async () => {
    const snap = await readClaudeQuota({ homeDir: home, now: () => NOW });
    expect(snap).toMatchObject({ core: 'claude', state: 'unknown' });
    expect(snap.state === 'unknown' && snap.reason).toMatch(/statusline quota cache/);
  });

  it('reports unknown for an unparseable cache', async () => {
    const dir = join(home, '.claude', 'cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'quota.json'), '{ not json');
    const snap = await readClaudeQuota({ homeDir: home, now: () => NOW });
    expect(snap.state === 'unknown' && snap.reason).toMatch(/could not be parsed/);
  });

  it('reports the windows from the cached statusline payload', async () => {
    writeCache(STATUSLINE);
    const snap = await readClaudeQuota({ homeDir: home, now: () => NOW });
    expect(snap).toMatchObject({ core: 'claude', state: 'ok', source: 'Claude statusline telemetry' });
    expect(snap.state === 'ok' && snap.windows.map((w) => w.label)).toEqual(['5-hour', '7-day']);
  });

  it("stamps readAt from the cache file's age, never the read time", async () => {
    const sixWeeksAgo = new Date(NOW.getTime() - 6 * 7 * 24 * 3_600_000);
    writeCache(STATUSLINE);
    const cachePath = join(home, '.claude', 'cache', 'quota.json');
    utimesSync(cachePath, sixWeeksAgo, sixWeeksAgo);
    const snap = await readClaudeQuota({ homeDir: home, now: () => NOW });
    expect(snap.state === 'ok' && snap.readAt).toBe(sixWeeksAgo.toISOString());
  });

  it('honors CLAUDE_CONFIG_DIR for the cache location', async () => {
    const custom = join(home, 'custom-claude');
    writeCache(STATUSLINE, custom);
    const snap = await readClaudeQuota({ homeDir: home, env: { CLAUDE_CONFIG_DIR: custom }, now: () => NOW });
    expect(snap.state).toBe('ok');
  });
});

const API_USAGE = {
  five_hour: { utilization: 0.5, resetsAt: 1746540000 },
  seven_day: { utilization: 0.25, resetsAt: 1746799200 },
};

function writeCredentials(token = 'test-token'): void {
  const dir = join(home, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token } }),
  );
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers });
}

function usageApi(fetchFn: typeof fetch, over: Partial<ClaudeUsageApiDeps> = {}): ClaudeUsageApiDeps {
  return { enabled: () => true, platform: 'linux', fetchFn, ...over };
}

function cacheMtime(at: Date): void {
  const cachePath = join(home, '.claude', 'cache', 'quota.json');
  utimesSync(cachePath, at, at);
}

describe('readClaudeQuota — cache-first opt-in API fallback', () => {
  it('never calls the API while the statusline cache is fresh', async () => {
    writeCache(STATUSLINE);
    cacheMtime(NOW);
    writeCredentials();
    const fetchFn = vi.fn(async () => jsonResponse(API_USAGE)) as unknown as typeof fetch;
    const snap = await readClaudeQuota({
      homeDir: home,
      now: () => NOW,
      usageApi: usageApi(fetchFn),
    });
    expect(snap).toMatchObject({ core: 'claude', state: 'ok', source: 'Claude statusline telemetry' });
    expect(snap.state === 'ok' && snap.windows[0]!.usedPct).toBe(34);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('calls the API when the cache is stale and reports its windows', async () => {
    writeCache(STATUSLINE);
    cacheMtime(new Date(NOW.getTime() - 10 * 60_000));
    writeCredentials();
    const fetchFn = vi.fn(async () => jsonResponse(API_USAGE)) as unknown as typeof fetch;
    const snap = await readClaudeQuota({
      homeDir: home,
      now: () => NOW,
      usageApi: usageApi(fetchFn),
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(snap).toMatchObject({ core: 'claude', state: 'ok', source: 'Claude OAuth usage API' });
    expect(snap.state === 'ok' && snap.windows.map((w) => w.usedPct)).toEqual([50, 25]);
    expect(snap.state === 'ok' && snap.readAt).toBe(NOW.toISOString());
  });

  it('keeps the stale cache value when the API rejects the token', async () => {
    writeCache(STATUSLINE);
    cacheMtime(new Date(NOW.getTime() - 10 * 60_000));
    writeCredentials();
    const snap = await readClaudeQuota({
      homeDir: home,
      now: () => NOW,
      usageApi: usageApi((async () => jsonResponse({}, 401)) as unknown as typeof fetch),
    });
    expect(snap).toMatchObject({ state: 'ok', source: 'Claude statusline telemetry' });
    expect(snap.state === 'ok' && snap.windows[0]!.usedPct).toBe(34);
  });

  it('reports unknown with the API reason when there is no cache to fall back to', async () => {
    writeCredentials();
    const snap = await readClaudeQuota({
      homeDir: home,
      now: () => NOW,
      usageApi: usageApi((async () => jsonResponse({}, 401)) as unknown as typeof fetch),
    });
    expect(snap).toEqual({
      core: 'claude',
      state: 'unknown',
      reason: 'the Claude usage API rejected the OAuth token (401)',
    });
  });

  it('stays cache-only when the opt-in setting is OFF', async () => {
    writeCache(STATUSLINE);
    cacheMtime(new Date(NOW.getTime() - 10 * 60_000));
    const fetchFn = vi.fn(async () => jsonResponse(API_USAGE)) as unknown as typeof fetch;
    const snap = await readClaudeQuota({
      homeDir: home,
      now: () => NOW,
      usageApi: usageApi(fetchFn, { enabled: () => false }),
    });
    expect(snap).toMatchObject({ state: 'ok', source: 'Claude statusline telemetry' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('keeps the last good API snapshot when a later poll fails', async () => {
    writeCredentials();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(API_USAGE))
      .mockResolvedValueOnce(jsonResponse({}, 401));
    const reader = claudeQuotaReader({
      homeDir: home,
      now: () => NOW,
      usageApi: usageApi(fetchFn as unknown as typeof fetch),
    });
    const first = await reader.read();
    const second = await reader.read();
    expect(first).toMatchObject({ state: 'ok', source: 'Claude OAuth usage API' });
    expect(second).toEqual(first);
  });

  it('backs off for the 429 Retry-After window, then retries', async () => {
    writeCredentials();
    let now = NOW;
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '300' }))
      .mockResolvedValueOnce(jsonResponse(API_USAGE));
    const reader = claudeQuotaReader({
      homeDir: home,
      now: () => now,
      usageApi: usageApi(fetchFn as unknown as typeof fetch),
    });
    expect(await reader.read()).toMatchObject({ state: 'unknown' });
    expect((await reader.read()).state).toBe('unknown');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now = new Date(NOW.getTime() + 300_000);
    expect(await reader.read()).toMatchObject({ state: 'ok', source: 'Claude OAuth usage API' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
