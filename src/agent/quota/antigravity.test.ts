import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  antigravityQuotaReader,
  antigravityQuotaCachePath,
  asRecord,
  num,
  findNumber,
  writeCache,
  readCache,
  parseAntigravityWindows,
  ANTIGRAVITY_QUOTA_SOURCE,
  ANTIGRAVITY_CACHE_TTL_MS,
  ANTIGRAVITY_TIMEOUT_MS,
  ANTIGRAVITY_RELATIVE_CACHE,
} from './antigravity.js';
import type { QuotaKnown } from './types.js';

describe('antigravityQuotaCachePath and constants', () => {
  it('returns join(appDataDir, "cache", "quota.json")', () => {
    expect(antigravityQuotaCachePath('/test/dir')).toBe(join('/test/dir', 'cache', 'quota.json'));
    expect(ANTIGRAVITY_RELATIVE_CACHE).toBe(join('cache', 'quota.json'));
    expect(ANTIGRAVITY_CACHE_TTL_MS).toBe(86_400_000);
    expect(ANTIGRAVITY_TIMEOUT_MS).toBe(2000);
    expect(ANTIGRAVITY_QUOTA_SOURCE).toBe('Antigravity Language Server');
  });
});

describe('asRecord and num helpers', () => {
  it('asRecord returns Record only for plain non-array objects', () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord(undefined)).toBeNull();
    expect(asRecord('string')).toBeNull();
    expect(asRecord(123)).toBeNull();
    expect(asRecord(true)).toBeNull();
    expect(asRecord(false)).toBeNull();
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord([])).toBeNull();
    expect(asRecord({ key: 'val' })).toEqual({ key: 'val' });
    expect(asRecord({})).toEqual({});
  });

  it('num returns number only for finite numbers', () => {
    expect(num(42)).toBe(42);
    expect(num(0)).toBe(0);
    expect(num(-5)).toBe(-5);
    expect(num(3.14)).toBe(3.14);
    expect(num('42')).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num(NaN)).toBeNull();
    expect(num(Infinity)).toBeNull();
    expect(num(-Infinity)).toBeNull();
    expect(num({})).toBeNull();
  });

  it('findNumber scans source hierarchy and skips null sources', () => {
    expect(findNumber([null, undefined, { a: 10 }], 'a')).toBe(10);
    expect(findNumber([{ a: 'not-num' }, { a: 20 }], 'a')).toBe(20);
    expect(findNumber([null, { b: 5 }], 'a')).toBeNull();
    expect(findNumber([], 'a')).toBeNull();
  });
});

describe('parseAntigravityWindows', () => {
  it('returns empty array for non-objects or empty input', () => {
    expect(parseAntigravityWindows(null)).toEqual([]);
    expect(parseAntigravityWindows(undefined)).toEqual([]);
    expect(parseAntigravityWindows('string')).toEqual([]);
    expect(parseAntigravityWindows(123)).toEqual([]);
    expect(parseAntigravityWindows([])).toEqual([]);
    expect(parseAntigravityWindows({})).toEqual([]);
  });

  it('parses Prompt Credits with exact integer math', () => {
    const raw = {
      userStatus: {
        planStatus: {
          planInfo: {
            monthlyPromptCredits: 1000,
            availablePromptCredits: 350,
          },
        },
      },
    };
    const windows = parseAntigravityWindows(raw);
    expect(windows).toEqual([
      {
        label: 'Prompt Credits',
        usedPct: 65,
        resetsAt: null,
      },
    ]);
  });

  it('parses Prompt Credits with non-integer rounding', () => {
    const raw = {
      planInfo: {
        monthlyPromptCredits: 3,
        availablePromptCredits: 1,
      },
    };
    // ((3 - 1) / 3) * 100 = 66.666... -> Math.round -> 67
    const windows = parseAntigravityWindows(raw);
    expect(windows).toEqual([
      {
        label: 'Prompt Credits',
        usedPct: 67,
        resetsAt: null,
      },
    ]);
  });

  it('finds Prompt Credits across planStatus, userStatus and root levels', () => {
    expect(
      parseAntigravityWindows({
        planStatus: { monthlyPromptCredits: 100, availablePromptCredits: 20 },
      }),
    ).toEqual([{ label: 'Prompt Credits', usedPct: 80, resetsAt: null }]);

    expect(
      parseAntigravityWindows({
        userStatus: { monthlyPromptCredits: 100, availablePromptCredits: 50 },
      }),
    ).toEqual([{ label: 'Prompt Credits', usedPct: 50, resetsAt: null }]);

    expect(
      parseAntigravityWindows({
        monthlyPromptCredits: 100,
        availablePromptCredits: 10,
      }),
    ).toEqual([{ label: 'Prompt Credits', usedPct: 90, resetsAt: null }]);
  });

  it('omits Prompt Credits when monthlyPromptCredits is 0, negative, or not a number', () => {
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyPromptCredits: 0, availablePromptCredits: 0 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyPromptCredits: -10, availablePromptCredits: 5 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyPromptCredits: 'invalid', availablePromptCredits: 5 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyPromptCredits: 100, availablePromptCredits: 'invalid' },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyPromptCredits: 100 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { availablePromptCredits: 50 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyPromptCredits: NaN, availablePromptCredits: 50 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyPromptCredits: 100, availablePromptCredits: NaN },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyPromptCredits: Infinity, availablePromptCredits: 50 },
      }),
    ).toEqual([]);
  });

  it('parses Flow Credits with exact integer math', () => {
    const raw = {
      planStatus: {
        planInfo: {
          monthlyFlowCredits: 200,
          availableFlowCredits: 50,
        },
      },
    };
    const windows = parseAntigravityWindows(raw);
    expect(windows).toEqual([
      {
        label: 'Flow Credits',
        usedPct: 75,
        resetsAt: null,
      },
    ]);
  });

  it('parses Flow Credits with non-integer rounding', () => {
    const raw = {
      monthlyFlowCredits: 200,
      availableFlowCredits: 65,
    };
    // ((200 - 65) / 200) * 100 = 67.5 -> Math.round -> 68
    const windows = parseAntigravityWindows(raw);
    expect(windows).toEqual([
      {
        label: 'Flow Credits',
        usedPct: 68,
        resetsAt: null,
      },
    ]);
  });

  it('finds Flow Credits across planStatus, userStatus and root levels', () => {
    expect(
      parseAntigravityWindows({
        planStatus: { monthlyFlowCredits: 100, availableFlowCredits: 20 },
      }),
    ).toEqual([{ label: 'Flow Credits', usedPct: 80, resetsAt: null }]);

    expect(
      parseAntigravityWindows({
        userStatus: { monthlyFlowCredits: 100, availableFlowCredits: 50 },
      }),
    ).toEqual([{ label: 'Flow Credits', usedPct: 50, resetsAt: null }]);

    expect(
      parseAntigravityWindows({
        monthlyFlowCredits: 100,
        availableFlowCredits: 10,
      }),
    ).toEqual([{ label: 'Flow Credits', usedPct: 90, resetsAt: null }]);
  });

  it('omits Flow Credits when monthlyFlowCredits is 0, negative, or not a number', () => {
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyFlowCredits: 0, availableFlowCredits: 0 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyFlowCredits: -5, availableFlowCredits: 2 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyFlowCredits: 'abc', availableFlowCredits: 2 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyFlowCredits: 100, availableFlowCredits: 'abc' },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyFlowCredits: 100 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { availableFlowCredits: 50 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyFlowCredits: NaN, availableFlowCredits: 50 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyFlowCredits: 100, availableFlowCredits: NaN },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        planInfo: { monthlyFlowCredits: Infinity, availableFlowCredits: 50 },
      }),
    ).toEqual([]);
  });

  it('parses Model Quota with label and resetTime', () => {
    const raw = {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: 'Gemini 3 Flash',
              modelId: 'gemini-3-flash',
              quotaInfo: {
                remainingFraction: 0.25,
                resetTime: '2026-10-30T12:00:00Z',
              },
            },
          ],
        },
      },
    };
    const windows = parseAntigravityWindows(raw);
    expect(windows).toEqual([
      {
        label: 'Gemini 3 Flash',
        usedPct: 75,
        resetsAt: '2026-10-30T12:00:00Z',
      },
    ]);
  });

  it('parses Model Quota with non-integer rounding and null resetTime', () => {
    const raw = {
      clientModelConfigs: [
        {
          label: 'Gemini 3 Pro',
          modelId: 'gemini-3-pro',
          quotaInfo: {
            remainingFraction: 0.333,
          },
        },
      ],
    };
    // (1 - 0.333) * 100 = 66.7 -> Math.round -> 67
    const windows = parseAntigravityWindows(raw);
    expect(windows).toEqual([
      {
        label: 'Gemini 3 Pro',
        usedPct: 67,
        resetsAt: null,
      },
    ]);
  });

  it('sets resetsAt to null when resetTime is empty string or not a string', () => {
    const raw = {
      clientModelConfigs: [
        {
          label: 'M1',
          quotaInfo: { remainingFraction: 0.5, resetTime: '' },
        },
        {
          label: 'M2',
          quotaInfo: { remainingFraction: 0.5, resetTime: 12345 },
        },
        {
          label: 'M3',
          quotaInfo: { remainingFraction: 0.5, resetTime: null },
        },
      ],
    };
    const windows = parseAntigravityWindows(raw);
    expect(windows).toEqual([
      { label: 'M1', usedPct: 50, resetsAt: null },
      { label: 'M2', usedPct: 50, resetsAt: null },
      { label: 'M3', usedPct: 50, resetsAt: null },
    ]);
  });

  it('falls back to modelId when label is missing, or "Model" when both are missing', () => {
    const raw = {
      clientModelConfigs: [
        {
          modelId: 'gemini-fallback',
          quotaInfo: { remainingFraction: 0.5 },
        },
        {
          quotaInfo: { remainingFraction: 0.1 },
        },
        {
          label: '',
          modelId: '',
          quotaInfo: { remainingFraction: 0.4 },
        },
      ],
    };
    const windows = parseAntigravityWindows(raw);
    expect(windows).toEqual([
      { label: 'gemini-fallback', usedPct: 50, resetsAt: null },
      { label: 'Model', usedPct: 90, resetsAt: null },
      { label: 'Model', usedPct: 60, resetsAt: null },
    ]);
  });

  it('skips model configs without quotaInfo or without remainingFraction', () => {
    const raw = {
      clientModelConfigs: [
        {
          label: 'Gemini 4 Argon (Medium)',
          modelId: 'gemini-4-argon-medium',
          quotaInfo: {
            resetTime: '2026-10-30T16:16:10Z',
          },
        },
        {
          label: 'No Quota Info',
          modelId: 'no-quota-info',
        },
        {
          label: 'Invalid Fraction',
          quotaInfo: { remainingFraction: 'not-a-number' },
        },
        {
          label: 'NaN Fraction',
          quotaInfo: { remainingFraction: NaN },
        },
        {
          label: 'Infinity Fraction',
          quotaInfo: { remainingFraction: Infinity },
        },
        null,
        'not-an-object',
      ],
    };
    expect(parseAntigravityWindows(raw)).toEqual([]);
  });

  it('parses the real language_server_get_user_status fixture', () => {
    const fixture = {
      userStatus: {
        planStatus: {
          planInfo: {
            teamsTier: 'TEAMS_TIER_PRO',
            planName: 'Pro',
            availablePromptCredits: 500,
            availableFlowCredits: 100,
          },
        },
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: 'Gemini 4 Argon (Medium)',
              modelId: 'gemini-4-argon-medium',
              quotaInfo: {
                resetTime: '2026-10-30T16:16:10Z',
              },
            },
            {
              label: 'Tab Flash Lite Preview',
              modelId: 'tab_flash_lite_preview',
              quotaInfo: {
                remainingFraction: 1.0,
              },
            },
          ],
        },
      },
    };
    const windows = parseAntigravityWindows(fixture);
    expect(windows).toEqual([
      {
        label: 'Tab Flash Lite Preview',
        usedPct: 0,
        resetsAt: null,
      },
    ]);
  });
});

describe('writeCache and readCache helpers', () => {
  function createTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'karst-test-cache-'));
  }

  it('writeCache creates deeply nested directories recursively', () => {
    const baseDir = createTempDir();
    try {
      const cachePath = join(baseDir, 'deep', 'nested', 'path', 'quota.json');
      const snapshot: QuotaKnown = {
        core: 'antigravity',
        state: 'ok',
        source: 'Antigravity Language Server',
        readAt: '2026-10-29T10:00:00.000Z',
        windows: [{ label: 'W', usedPct: 10, resetsAt: null }],
      };
      writeCache(cachePath, snapshot);
      expect(existsSync(cachePath)).toBe(true);
      expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toEqual(snapshot);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('writeCache catches errors silently and does not throw', () => {
    // Write to illegal path
    expect(() => writeCache('/dev/null/impossible/quota.json', {
      core: 'antigravity',
      state: 'ok',
      source: 'test',
      readAt: '2026-01-01T00:00:00.000Z',
      windows: [],
    })).not.toThrow();
  });

  it('readCache returns null for missing or invalid files', async () => {
    const baseDir = createTempDir();
    try {
      expect(await readCache(join(baseDir, 'nonexistent.json'), 0, 1000)).toBeNull();

      const corruptPath = join(baseDir, 'corrupt.json');
      writeFileSync(corruptPath, 'not-json');
      expect(await readCache(corruptPath, 0, 1000)).toBeNull();

      const nullPath = join(baseDir, 'null.json');
      writeFileSync(nullPath, 'null');
      expect(await readCache(nullPath, 0, 1000)).toBeNull();

      const primitivePath = join(baseDir, 'primitive.json');
      writeFileSync(primitivePath, '"hello"');
      expect(await readCache(primitivePath, 0, 1000)).toBeNull();

      const arrayPath = join(baseDir, 'array.json');
      writeFileSync(arrayPath, '[]');
      expect(await readCache(arrayPath, 0, 1000)).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('readCache validates core, state, windows, and readAt structure', async () => {
    const baseDir = createTempDir();
    try {
      const testPath = join(baseDir, 'test.json');

      // Wrong core
      writeFileSync(testPath, JSON.stringify({ core: 'codex', state: 'ok', windows: [] }));
      expect(await readCache(testPath, 0, 1000)).toBeNull();

      // Wrong state
      writeFileSync(testPath, JSON.stringify({ core: 'antigravity', state: 'unknown', windows: [] }));
      expect(await readCache(testPath, 0, 1000)).toBeNull();

      // Windows not array
      writeFileSync(testPath, JSON.stringify({ core: 'antigravity', state: 'ok', windows: 'none' }));
      expect(await readCache(testPath, 0, 1000)).toBeNull();

      // readAt missing or not string
      writeFileSync(testPath, JSON.stringify({ core: 'antigravity', state: 'ok', windows: [] }));
      expect(await readCache(testPath, 0, 1000)).toBeNull();

      writeFileSync(testPath, JSON.stringify({ core: 'antigravity', state: 'ok', windows: [], readAt: 123 }));
      expect(await readCache(testPath, 0, 1000)).toBeNull();

      // readAt invalid date
      writeFileSync(testPath, JSON.stringify({ core: 'antigravity', state: 'ok', windows: [], readAt: 'invalid' }));
      expect(await readCache(testPath, 0, 1000)).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('readCache handles ageMs === 0, exact TTL boundary, and preserves/defaults source', async () => {
    const baseDir = createTempDir();
    try {
      const cachePath = join(baseDir, 'valid.json');
      const readAt = '2026-10-29T10:00:00.000Z';
      const readAtMs = new Date(readAt).getTime();
      const ttlMs = 10_000;

      // Age === 0 (nowMs === readAtMs)
      writeFileSync(
        cachePath,
        JSON.stringify({
          core: 'antigravity',
          state: 'ok',
          windows: [{ label: 'W', usedPct: 5, resetsAt: null }],
          readAt,
        }),
      );
      const res0 = await readCache(cachePath, readAtMs, ttlMs);
      expect(res0).not.toBeNull();
      expect(res0?.source).toBe(ANTIGRAVITY_QUOTA_SOURCE);
      expect(res0?.readAt).toBe(readAt);

      // Exact TTL boundary (ageMs === ttlMs)
      const resBoundary = await readCache(cachePath, readAtMs + ttlMs, ttlMs);
      expect(resBoundary).not.toBeNull();

      // Expired by 1ms (ageMs === ttlMs + 1)
      const resExpired = await readCache(cachePath, readAtMs + ttlMs + 1, ttlMs);
      expect(resExpired).toBeNull();

      // Future stamp (ageMs < 0)
      const resFuture = await readCache(cachePath, readAtMs - 1000, ttlMs);
      expect(resFuture).toBeNull();

      // Preserves custom source if string
      writeFileSync(
        cachePath,
        JSON.stringify({
          core: 'antigravity',
          state: 'ok',
          windows: [{ label: 'W', usedPct: 5, resetsAt: null }],
          source: 'Custom Gateway',
          readAt,
        }),
      );
      const resCustom = await readCache(cachePath, readAtMs, ttlMs);
      expect(resCustom?.source).toBe('Custom Gateway');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe('antigravityQuotaReader', () => {
  function createTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'karst-test-antigravity-'));
  }

  it('makes live POST request to GetUserStatus with required headers and writes atomic cache', async () => {
    const appDataDir = createTempDir();
    try {
      let capturedUrl = '';
      let capturedOptions: RequestInit | undefined;

      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedOptions = init;
        return new Response(
          JSON.stringify({
            userStatus: {
              planStatus: {
                planInfo: {
                  monthlyPromptCredits: 1000,
                  availablePromptCredits: 400,
                  monthlyFlowCredits: 500,
                  availableFlowCredits: 250,
                },
              },
              cascadeModelConfigData: {
                clientModelConfigs: [
                  {
                    label: 'Gemini 3 Pro',
                    quotaInfo: {
                      remainingFraction: 0.2,
                      resetTime: '2026-10-30T18:00:00Z',
                    },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const reader = antigravityQuotaReader({
        appDataDir,
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: 'secret-csrf-token-xyz',
        },
        now: () => new Date('2026-10-29T10:00:00.000Z'),
        fetchImpl,
      });

      const snapshot = await reader.read();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe(
        'http://127.0.0.1:45123/exa.language_server_pb.LanguageServerService/GetUserStatus',
      );
      expect(capturedOptions?.method).toBe('POST');
      expect(capturedOptions?.body).toBe('{}');
      expect(capturedOptions?.headers).toEqual({
        'Connect-Protocol-Version': '1',
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': 'secret-csrf-token-xyz',
      });
      expect(capturedOptions?.signal).toBeDefined();

      expect(snapshot).toEqual({
        core: 'antigravity',
        state: 'ok',
        source: 'Antigravity Language Server',
        readAt: '2026-10-29T10:00:00.000Z',
        windows: [
          { label: 'Prompt Credits', usedPct: 60, resetsAt: null },
          { label: 'Flow Credits', usedPct: 50, resetsAt: null },
          { label: 'Gemini 3 Pro', usedPct: 80, resetsAt: '2026-10-30T18:00:00Z' },
        ],
      });

      // Verify atomic cache write to <appDataDir>/cache/quota.json
      const cachePath = join(appDataDir, 'cache', 'quota.json');
      expect(existsSync(cachePath)).toBe(true);

      const cachedRaw = readFileSync(cachePath, 'utf8');
      const cached = JSON.parse(cachedRaw);
      expect(cached).toEqual(snapshot);

      // Verify CSRF token is NEVER in cache file
      expect(cachedRaw).not.toContain('secret-csrf-token-xyz');
      expect(cachedRaw).not.toContain('ANTIGRAVITY_CSRF_TOKEN');
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('falls back to cache within 24h TTL and preserves readAt when live call fails', async () => {
    const appDataDir = createTempDir();
    try {
      const cachePath = join(appDataDir, 'cache', 'quota.json');
      mkdirSync(join(appDataDir, 'cache'), { recursive: true });

      const cachedSnapshot: QuotaKnown = {
        core: 'antigravity',
        state: 'ok',
        source: 'Antigravity Language Server',
        readAt: '2026-10-28T12:00:00.000Z',
        windows: [{ label: 'Prompt Credits', usedPct: 40, resetsAt: null }],
      };
      writeFileSync(cachePath, JSON.stringify(cachedSnapshot), 'utf8');

      const fetchImpl = vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:45123');
      }) as unknown as typeof fetch;

      // 10 hours later (within 24h TTL)
      const now = () => new Date('2026-10-28T22:00:00.000Z');

      const reader = antigravityQuotaReader({
        appDataDir,
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: 'token',
        },
        now,
        fetchImpl,
      });

      const snapshot = await reader.read();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // Returns cached snapshot with preserved readAt
      expect(snapshot).toEqual(cachedSnapshot);
      expect(snapshot.state).toBe('ok');
      if (snapshot.state === 'ok') {
        expect(snapshot.readAt).toBe('2026-10-28T12:00:00.000Z');
      }
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('reports unknown with ANTIGRAVITY_LS_ADDRESS is not set when address is missing/empty and no cache', async () => {
    const appDataDir = createTempDir();
    try {
      const readerMissing = antigravityQuotaReader({
        appDataDir,
        env: { ANTIGRAVITY_CSRF_TOKEN: 'csrf-only' },
        now: () => new Date(0),
      });
      expect(await readerMissing.read()).toEqual({
        core: 'antigravity',
        state: 'unknown',
        reason: 'ANTIGRAVITY_LS_ADDRESS is not set',
      });

      const readerEmpty = antigravityQuotaReader({
        appDataDir,
        env: { ANTIGRAVITY_LS_ADDRESS: '', ANTIGRAVITY_CSRF_TOKEN: 'csrf-only' },
        now: () => new Date(0),
      });
      expect(await readerEmpty.read()).toEqual({
        core: 'antigravity',
        state: 'unknown',
        reason: 'ANTIGRAVITY_LS_ADDRESS is not set',
      });
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('reports unknown with ANTIGRAVITY_CSRF_TOKEN is not set when token is missing/empty and no cache', async () => {
    const appDataDir = createTempDir();
    try {
      const readerMissing = antigravityQuotaReader({
        appDataDir,
        env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123' },
        now: () => new Date(0),
      });
      expect(await readerMissing.read()).toEqual({
        core: 'antigravity',
        state: 'unknown',
        reason: 'ANTIGRAVITY_CSRF_TOKEN is not set',
      });

      const readerEmpty = antigravityQuotaReader({
        appDataDir,
        env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123', ANTIGRAVITY_CSRF_TOKEN: '' },
        now: () => new Date(0),
      });
      expect(await readerEmpty.read()).toEqual({
        core: 'antigravity',
        state: 'unknown',
        reason: 'ANTIGRAVITY_CSRF_TOKEN is not set',
      });
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('falls back to cache when HTTP response is not ok (e.g. 500)', async () => {
    const appDataDir = createTempDir();
    try {
      const cachePath = join(appDataDir, 'cache', 'quota.json');
      mkdirSync(join(appDataDir, 'cache'), { recursive: true });
      const cachedSnapshot: QuotaKnown = {
        core: 'antigravity',
        state: 'ok',
        source: 'Antigravity Language Server',
        readAt: '2026-10-29T09:00:00.000Z',
        windows: [{ label: 'Flow Credits', usedPct: 10, resetsAt: null }],
      };
      writeFileSync(cachePath, JSON.stringify(cachedSnapshot), 'utf8');

      const fetchImpl = vi.fn(
        async () => new Response('Internal error', { status: 500 }),
      ) as unknown as typeof fetch;

      const reader = antigravityQuotaReader({
        appDataDir,
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: 'token',
        },
        now: () => new Date('2026-10-29T10:00:00.000Z'),
        fetchImpl,
      });

      const snapshot = await reader.read();
      expect(snapshot).toEqual(cachedSnapshot);
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('falls back to unknown when HTTP 500 and no cache exists', async () => {
    const appDataDir = createTempDir();
    try {
      const fetchImpl = vi.fn(
        async () => new Response('Internal error', { status: 500 }),
      ) as unknown as typeof fetch;

      const reader = antigravityQuotaReader({
        appDataDir,
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: 'token',
        },
        now: () => new Date(0),
        fetchImpl,
      });

      const snapshot = await reader.read();
      expect(snapshot).toEqual({
        core: 'antigravity',
        state: 'unknown',
        reason: 'Language server HTTP 500',
      });
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('falls back to cache when response has 0 quota windows', async () => {
    const appDataDir = createTempDir();
    try {
      const cachePath = join(appDataDir, 'cache', 'quota.json');
      mkdirSync(join(appDataDir, 'cache'), { recursive: true });
      const cachedSnapshot: QuotaKnown = {
        core: 'antigravity',
        state: 'ok',
        source: 'Antigravity Language Server',
        readAt: '2026-10-29T09:00:00.000Z',
        windows: [{ label: 'Flow Credits', usedPct: 10, resetsAt: null }],
      };
      writeFileSync(cachePath, JSON.stringify(cachedSnapshot), 'utf8');

      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({}), { status: 200 }),
      ) as unknown as typeof fetch;

      const reader = antigravityQuotaReader({
        appDataDir,
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: 'token',
        },
        now: () => new Date('2026-10-29T10:00:00.000Z'),
        fetchImpl,
      });

      const snapshot = await reader.read();
      expect(snapshot).toEqual(cachedSnapshot);
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('falls back to unknown when response has 0 quota windows and no cache', async () => {
    const appDataDir = createTempDir();
    try {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({}), { status: 200 }),
      ) as unknown as typeof fetch;

      const reader = antigravityQuotaReader({
        appDataDir,
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: 'token',
        },
        now: () => new Date(0),
        fetchImpl,
      });

      const snapshot = await reader.read();
      expect(snapshot).toEqual({
        core: 'antigravity',
        state: 'unknown',
        reason: 'No quota windows in language server response',
      });
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('resolves appDataDir using injected homeDir or default homedir', async () => {
    const fakeHome = createTempDir();
    try {
      const readerWithHome = antigravityQuotaReader({
        homeDir: fakeHome,
        env: {},
        now: () => new Date(0),
      });
      const snap1 = await readerWithHome.read();
      expect(snap1.core).toBe('antigravity');
      expect(snap1.state).toBe('unknown');

      // Test with no homeDir provided (uses homedir())
      const readerDefaultHome = antigravityQuotaReader({
        env: {},
        now: () => new Date(0),
      });
      const snap2 = await readerDefaultHome.read();
      expect(snap2.core).toBe('antigravity');
      expect(snap2.state).toBe('unknown');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
