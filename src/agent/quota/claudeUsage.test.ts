import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_USAGE_URL,
  ClaudeUsageClient,
  claudeKeychainServices,
  fetchClaudeUsage,
  parseClaudeCredentials,
  parseClaudeUsageWindows,
  parseRetryAfterMs,
  readClaudeOAuthToken,
  type ClaudeUsageOptions,
} from './claudeUsage.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const TOKEN = 'sk-ant-oat01-SECRET-TOKEN-VALUE';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'karst-claude-usage-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeCredentials(token = TOKEN, expiresAt?: number): string {
  const configDir = join(home, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, ...(expiresAt === undefined ? {} : { expiresAt }) } }),
  );
  return configDir;
}

function options(over: Partial<ClaudeUsageOptions> = {}): ClaudeUsageOptions {
  return {
    enabled: () => true,
    configDir: join(home, '.claude'),
    now: () => NOW,
    platform: 'linux',
    fetchFn: vi.fn(async () => jsonResponse({})) as unknown as typeof fetch,
    ...over,
  };
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const USAGE = {
  five_hour: { utilization: 0.34, resetsAt: 1746540000 },
  seven_day: { utilization: 0.12, resetsAt: 1746799200 },
  seven_day_sonnet: { utilization: 0.99, resetsAt: 1746799200 },
  seven_day_opus: { utilization: 0.9, resetsAt: 1746799200 },
};

describe('parseClaudeUsageWindows', () => {
  it('maps the 5-hour and 7-day windows, ignoring the model-scoped blocks', () => {
    expect(parseClaudeUsageWindows(USAGE)).toEqual([
      { label: '5-hour', usedPct: 34, resetsAt: new Date(1746540000 * 1000).toISOString() },
      { label: '7-day', usedPct: 12, resetsAt: new Date(1746799200 * 1000).toISOString() },
    ]);
  });

  it('rounds float noise and clamps to 0-100', () => {
    const windows = parseClaudeUsageWindows({
      five_hour: { utilization: 0.07 },
      seven_day: { utilization: 1.5 },
    });
    expect(windows.map((w) => w.usedPct)).toEqual([7, 100]);
    expect(windows[0]!.resetsAt).toBeNull();
  });

  it('skips a window whose utilization is not a number', () => {
    expect(parseClaudeUsageWindows({ five_hour: { utilization: '0.5' } })).toEqual([]);
  });

  it('returns [] for a non-object body', () => {
    expect(parseClaudeUsageWindows(null)).toEqual([]);
    expect(parseClaudeUsageWindows([])).toEqual([]);
  });
});

describe('parseClaudeCredentials', () => {
  it('reads the access token and expiry, never the refresh token', () => {
    const parsed = parseClaudeCredentials(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: TOKEN,
          refreshToken: 'refresh-secret',
          expiresAt: 1746540000000,
        },
      }),
    );
    expect(parsed).toEqual({ token: TOKEN, expiresAt: 1746540000000 });
    expect(JSON.stringify(parsed)).not.toContain('refresh-secret');
  });

  it('rejects malformed JSON and a missing/blank token', () => {
    expect(parseClaudeCredentials('{ not json')).toBeNull();
    expect(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
    expect(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: '  ' } }))).toBeNull();
  });
});

describe('claudeKeychainServices', () => {
  it('tries the per-config-dir suffixed item, then the default item', () => {
    expect(claudeKeychainServices('/Users/u/.claude')).toEqual(['Claude Code-credentials']);
    expect(claudeKeychainServices('/Users/u/.claude-work')).toEqual([
      'Claude Code-credentials-.claude-work',
      'Claude Code-credentials',
    ]);
  });
});

describe('readClaudeOAuthToken', () => {
  it('reads the macOS Keychain item, falling through to the default variant', async () => {
    const runSecurity = vi.fn(async (service: string) =>
      service === 'Claude Code-credentials'
        ? JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } })
        : null,
    );
    const lookup = await readClaudeOAuthToken({
      configDir: '/Users/u/.claude-work',
      now: NOW,
      platform: 'darwin',
      runSecurity,
    });
    expect(lookup).toEqual({ state: 'ok', token: TOKEN });
    expect(runSecurity.mock.calls.map(([s]) => s)).toEqual([
      'Claude Code-credentials-.claude-work',
      'Claude Code-credentials',
    ]);
  });

  it('reports an expired Keychain token without refreshing it', async () => {
    const lookup = await readClaudeOAuthToken({
      configDir: '/Users/u/.claude',
      now: NOW,
      platform: 'darwin',
      runSecurity: async () =>
        JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW.getTime() - 1 } }),
    });
    expect(lookup).toEqual({ state: 'unknown', reason: 'the Claude OAuth token has expired' });
  });

  it('reports a missing Keychain item', async () => {
    const lookup = await readClaudeOAuthToken({
      configDir: '/Users/u/.claude',
      now: NOW,
      platform: 'darwin',
      runSecurity: async () => null,
    });
    expect(lookup).toEqual({ state: 'unknown', reason: 'no Claude OAuth token in the macOS Keychain' });
  });

  it('reads .credentials.json on Linux', async () => {
    const configDir = writeCredentials();
    expect(await readClaudeOAuthToken({ configDir, now: NOW, platform: 'linux' })).toEqual({
      state: 'ok',
      token: TOKEN,
    });
  });

  it('reports a missing credentials file', async () => {
    const lookup = await readClaudeOAuthToken({
      configDir: join(home, '.claude'),
      now: NOW,
      platform: 'linux',
    });
    expect(lookup).toEqual({
      state: 'unknown',
      reason: expect.stringContaining('no Claude credentials file'),
    });
  });
});

describe('parseRetryAfterMs', () => {
  it('accepts delta-seconds and an HTTP date, with a bounded fallback', () => {
    expect(parseRetryAfterMs('120', NOW)).toBe(120_000);
    expect(parseRetryAfterMs(new Date(NOW.getTime() + 60_000).toUTCString(), NOW)).toBe(60_000);
    expect(parseRetryAfterMs(null, NOW)).toBe(5 * 60_000);
    expect(parseRetryAfterMs('nonsense', NOW)).toBe(5 * 60_000);
  });
});

describe('fetchClaudeUsage', () => {
  it('requests the usage endpoint with the bearer token and maps the windows', async () => {
    const configDir = writeCredentials();
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(USAGE),
    );
    const result = await fetchClaudeUsage(options({ configDir, fetchFn: fetchFn as unknown as typeof fetch }));
    expect(result).toEqual({ state: 'ok', windows: parseClaudeUsageWindows(USAGE) });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(CLAUDE_USAGE_URL);
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'anthropic-beta': 'oauth-2025-04-20',
    });
  });

  it('turns a 401 into unknown (no retry-after)', async () => {
    writeCredentials();
    const result = await fetchClaudeUsage(
      options({ fetchFn: (async () => jsonResponse({}, 401)) as unknown as typeof fetch }),
    );
    expect(result).toEqual({
      state: 'unknown',
      reason: 'the Claude usage API rejected the OAuth token (401)',
    });
  });

  it('honors Retry-After on a 429', async () => {
    writeCredentials();
    const result = await fetchClaudeUsage(
      options({
        fetchFn: (async () => jsonResponse({}, 429, { 'retry-after': '90' })) as unknown as typeof fetch,
      }),
    );
    expect(result).toEqual({
      state: 'unknown',
      reason: 'the Claude usage API is rate limited (429)',
      retryAfterMs: 90_000,
    });
  });

  it('turns a network failure into unknown without echoing its message', async () => {
    writeCredentials();
    const result = await fetchClaudeUsage(
      options({
        fetchFn: (async () => {
          throw new Error(`connect failed with ${TOKEN}`);
        }) as unknown as typeof fetch,
      }),
    );
    expect(result).toEqual({ state: 'unknown', reason: 'the Claude usage API request failed' });
  });

  it('turns an unparseable or windowless response into unknown', async () => {
    writeCredentials();
    const unparseable = await fetchClaudeUsage(
      options({
        fetchFn: (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
      }),
    );
    expect(unparseable).toEqual({
      state: 'unknown',
      reason: 'the Claude usage API returned an unparseable response',
    });
    const windowless = await fetchClaudeUsage(
      options({ fetchFn: (async () => jsonResponse({ five_hour: {} })) as unknown as typeof fetch }),
    );
    expect(windowless).toEqual({
      state: 'unknown',
      reason: 'the Claude usage API response carried no usable quota window',
    });
  });
});

describe('ClaudeUsageClient', () => {
  it('skips the network while a 429 Retry-After is open, then retries', async () => {
    writeCredentials();
    let now = NOW;
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '300' }))
      .mockResolvedValueOnce(jsonResponse(USAGE));
    const client = new ClaudeUsageClient(
      options({ now: () => now, fetchFn: fetchFn as unknown as typeof fetch }),
    );

    expect((await client.read()).state).toBe('unknown');
    expect((await client.read()).state).toBe('unknown');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now = new Date(NOW.getTime() + 300_000);
    expect(await client.read()).toEqual({ state: 'ok', windows: parseClaudeUsageWindows(USAGE) });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('reports a missing token without calling the network', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = new ClaudeUsageClient(options({ fetchFn: fetchFn as unknown as typeof fetch }));
    const result = await client.read();
    expect(result).toMatchObject({ state: 'unknown', reason: expect.stringContaining('credentials file') });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('token redaction', () => {
  it('never leaks the token into the result, a debug line or an error path', async () => {
    writeCredentials();
    const debug = vi.fn();
    const client = new ClaudeUsageClient(
      options({
        debug,
        fetchFn: (async () => jsonResponse({ error: `invalid token ${TOKEN}` }, 401)) as unknown as typeof fetch,
      }),
    );
    const result = await client.read();
    expect(result.state).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(debug).toHaveBeenCalled();
    for (const [message] of debug.mock.calls as [string][]) {
      expect(message).not.toContain(TOKEN);
    }
  });
});
