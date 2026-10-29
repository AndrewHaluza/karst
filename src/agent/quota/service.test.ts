import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaService, defaultQuotaReaders } from './service.js';
import type { QuotaReader, QuotaSnapshot } from './types.js';

function okSnapshot(core: QuotaSnapshot['core'], usedPct: number): QuotaSnapshot {
  return {
    core,
    state: 'ok',
    windows: [{ label: 'w', usedPct, resetsAt: null }],
    source: 'test',
    readAt: '2026-01-01T00:00:00.000Z',
  };
}

function okReader(core: QuotaSnapshot['core'], usedPct: number): QuotaReader {
  return { core, read: async () => okSnapshot(core, usedPct) };
}

describe('QuotaService', () => {
  it('caches one snapshot per reader and never reads on snapshots()', async () => {
    const read = vi.fn(async () => okSnapshot('codex', 10));
    const service = new QuotaService({ readers: [{ core: 'codex', read }] });
    expect(service.snapshots()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    await service.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    expect(service.get('codex')).toMatchObject({ core: 'codex', state: 'ok' });
    expect(service.snapshots()).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('turns a throwing reader into that core unknown, leaving the others, and logs', async () => {
    const debug = vi.fn();
    const service = new QuotaService({
      readers: [
        {
          core: 'codex',
          read: async () => {
            throw new Error('boom');
          },
        },
        okReader('claude', 42),
      ],
      debug,
    });
    await service.refresh();
    expect(service.get('codex')).toMatchObject({ state: 'unknown' });
    expect(service.get('claude')).toMatchObject({ state: 'ok' });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('codex'));
  });

  it('notifies onDidChange after a refresh', async () => {
    const onDidChange = vi.fn();
    const service = new QuotaService({ readers: [okReader('codex', 10)], onDidChange });
    await service.refresh();
    expect(onDidChange).toHaveBeenCalledWith([expect.objectContaining({ core: 'codex' })]);
  });

  it('start() refreshes once and is idempotent; dispose() clears the timer', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => okSnapshot('codex', 10));
      const service = new QuotaService({ readers: [{ core: 'codex', read }], pollMs: 1000 });
      service.start();
      service.start();
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(2);
      service.dispose();
      await vi.advanceTimersByTimeAsync(5000);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('defaultQuotaReaders', () => {
  it('registers one reader per core, in display order', () => {
    const readers = defaultQuotaReaders({ homeDir: '/nope', now: () => new Date(0) });
    expect(readers.map((r) => r.core)).toEqual([
      'claude',
      'codex',
      'antigravity',
      'opencode',
      'opencode2',
    ]);
  });

  it('reports antigravity unknown when language server is unreachable and no cache exists', async () => {
    const readers = defaultQuotaReaders({ homeDir: '/nope', env: {}, now: () => new Date(0) });
    const snap = await readers.find((r) => r.core === 'antigravity')!.read();
    expect(snap).toMatchObject({ core: 'antigravity', state: 'unknown' });
    expect(snap.state === 'unknown' && snap.reason.length).toBeGreaterThan(0);
  });

  it('reads antigravity live quota through injected fetch and env', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-quota-antigravity-'));
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              userStatus: {
                planStatus: {
                  planInfo: {
                    monthlyPromptCredits: 1000,
                    availablePromptCredits: 800,
                  },
                },
              },
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch;
      const readers = defaultQuotaReaders({
        homeDir: '/nope',
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: 'token-123',
        },
        now: () => new Date(0),
        fetchImpl,
        antigravityAppDataDir: dir,
      });
      const snap = await readers.find((r) => r.core === 'antigravity')!.read();
      expect(snap).toMatchObject({
        core: 'antigravity',
        state: 'ok',
        source: 'Antigravity Language Server',
        windows: [{ label: 'Prompt Credits', usedPct: 20, resetsAt: null }],
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads both OpenCode cores through their injected auth paths and fetch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-quota-opencode-'));
    try {
      const authPath = join(dir, 'auth.json');
      writeFileSync(authPath, JSON.stringify({ 'opencode-go': { key: 'go-key' } }));
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ usage: { rolling: { percent: 3, resetsAt: '2026-10-21T01:15:02.000Z' } } }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch;
      const readers = defaultQuotaReaders({
        homeDir: '/nope',
        env: {},
        now: () => new Date(0),
        opencodeAuthPath: authPath,
        opencode2AuthPath: authPath,
        fetchImpl,
      });
      for (const core of ['opencode', 'opencode2'] as const) {
        const snap = await readers.find((r) => r.core === core)!.read();
        expect(snap).toMatchObject({ core, state: 'ok', source: 'OpenCode Go usage API' });
      }
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function claudeCache(): string {
    const configDir = mkdtempSync(join(tmpdir(), 'karst-quota-env-'));
    mkdirSync(join(configDir, 'cache'), { recursive: true });
    writeFileSync(
      join(configDir, 'cache', 'quota.json'),
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 90, resets_at: 1746540000 } } }),
    );
    return configDir;
  }

  it('honors an injected CLAUDE_CONFIG_DIR for the claude reader', async () => {
    const configDir = claudeCache();
    try {
      const readers = defaultQuotaReaders({
        homeDir: '/nope',
        env: { CLAUDE_CONFIG_DIR: configDir },
        now: () => new Date(0),
      });
      const snap = await readers.find((r) => r.core === 'claude')!.read();
      expect(snap.state).toBe('ok');
      expect(snap.state === 'ok' && snap.windows[0]!.usedPct).toBe(90);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('defaults the reader env to process.env, so a real CLAUDE_CONFIG_DIR is honored', async () => {
    const configDir = claudeCache();
    try {
      vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
      const readers = defaultQuotaReaders({ homeDir: '/nope', now: () => new Date(0) });
      const snap = await readers.find((r) => r.core === 'claude')!.read();
      expect(snap.state).toBe('ok');
    } finally {
      vi.unstubAllEnvs();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('honors CODEX_HOME for the codex reader', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'karst-quota-codex-'));
    try {
      const dir = join(codexHome, 'sessions', '2026', '01', '01');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'rollout-x.jsonl'),
        JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 42, window_minutes: 300 } } } }) + '\n',
      );
      const readers = defaultQuotaReaders({
        homeDir: '/nope',
        env: { CODEX_HOME: codexHome },
        now: () => new Date(0),
      });
      const snap = await readers.find((r) => r.core === 'codex')!.read();
      expect(snap.state).toBe('ok');
      expect(snap.state === 'ok' && snap.windows[0]!.usedPct).toBe(42);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  describe('Claude usage API consent wiring (D185)', () => {
    const NOW = new Date('2026-01-01T00:00:00.000Z');

    function staleClaudeCache(): string {
      const configDir = mkdtempSync(join(tmpdir(), 'karst-quota-api-'));
      mkdirSync(join(configDir, 'cache'), { recursive: true });
      const cachePath = join(configDir, 'cache', 'quota.json');
      writeFileSync(
        cachePath,
        JSON.stringify({ rate_limits: { five_hour: { used_percentage: 90, resets_at: 1746540000 } } }),
      );
      const old = new Date(NOW.getTime() - 10 * 60_000);
      utimesSync(cachePath, old, old);
      writeFileSync(
        join(configDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } }),
      );
      return configDir;
    }

    function apiFetch(): typeof fetch {
      return vi.fn(async () =>
        new Response(JSON.stringify({ five_hour: { utilization: 0.42, resetsAt: 1746540000 } }), {
          status: 200,
        }),
      ) as unknown as typeof fetch;
    }

    it('stays cache-only while the consent closure is absent (default OFF)', async () => {
      const configDir = staleClaudeCache();
      try {
        const fetchFn = apiFetch();
        const readers = defaultQuotaReaders({
          homeDir: '/nope',
          env: { CLAUDE_CONFIG_DIR: configDir },
          now: () => NOW,
          platform: 'linux',
          fetchFn,
        });
        const snap = await readers.find((r) => r.core === 'claude')!.read();
        expect(snap).toMatchObject({ state: 'ok', source: 'Claude statusline telemetry' });
        expect(fetchFn).not.toHaveBeenCalled();
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('uses the API when the closure is ON and the cache is stale', async () => {
      const configDir = staleClaudeCache();
      try {
        const fetchFn = apiFetch();
        const readers = defaultQuotaReaders({
          homeDir: '/nope',
          env: { CLAUDE_CONFIG_DIR: configDir },
          now: () => NOW,
          platform: 'linux',
          fetchFn,
          claudeOauthUsageApi: () => true,
        });
        const snap = await readers.find((r) => r.core === 'claude')!.read();
        expect(snap).toMatchObject({ state: 'ok', source: 'Claude OAuth usage API' });
        expect(snap.state === 'ok' && snap.windows[0]!.usedPct).toBe(42);
        expect(fetchFn).toHaveBeenCalledOnce();
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });
});
