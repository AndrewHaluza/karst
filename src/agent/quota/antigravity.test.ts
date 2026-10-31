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
  detectAntigravityTier,
  antigravitySourceWithTier,
  windowDurationMinutes,
  resolveBucketLabel,
  writeCache,
  readCache,
  parseAntigravityWindows,
  ANTIGRAVITY_QUOTA_SOURCE,
  ANTIGRAVITY_CACHE_TTL_MS,
  ANTIGRAVITY_TIMEOUT_MS,
  ANTIGRAVITY_RELATIVE_CACHE,
  ANTIGRAVITY_NOT_RUNNING_REASON,
  ANTIGRAVITY_UNRESPONSIVE_REASON,
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
    expect(num(true)).toBeNull();
    expect(num(false)).toBeNull();
  });

  it('findNumber scans source hierarchy and skips null sources', () => {
    expect(findNumber([null, undefined, { a: 10 }], 'a')).toBe(10);
    expect(findNumber([{ a: 'not-num' }, { a: 20 }], 'a')).toBe(20);
    expect(findNumber([null, { b: 5 }], 'a')).toBeNull();
    expect(findNumber([], 'a')).toBeNull();
  });
});

describe('detectAntigravityTier', () => {
  it('returns unknown tier and isPaid=true when raw input is null, empty, or unparseable', () => {
    expect(detectAntigravityTier(null)).toEqual({ tier: 'unknown', tierName: null, isPaid: true });
    expect(detectAntigravityTier(undefined)).toEqual({ tier: 'unknown', tierName: null, isPaid: true });
    expect(detectAntigravityTier({})).toEqual({ tier: 'unknown', tierName: null, isPaid: true });
    expect(detectAntigravityTier('not-an-object')).toEqual({ tier: 'unknown', tierName: null, isPaid: true });
    expect(detectAntigravityTier({ userTier: { id: 123 } })).toEqual({
      tier: 'unknown',
      tierName: null,
      isPaid: true,
    });
  });

  it('detects Free tier via userTier.id or planInfo.teamsTier', () => {
    expect(detectAntigravityTier({ userTier: { id: 'free' } })).toEqual({
      tier: 'free',
      tierName: 'Free Tier',
      isPaid: false,
    });
    expect(detectAntigravityTier({ userTier: { id: 'free-tier' } })).toEqual({
      tier: 'free',
      tierName: 'Free Tier',
      isPaid: false,
    });
    expect(detectAntigravityTier({ planInfo: { teamsTier: 'TEAMS_TIER_FREE' } })).toEqual({
      tier: 'free',
      tierName: 'Free Tier',
      isPaid: false,
    });
    expect(
      detectAntigravityTier({
        userStatus: { planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_FREE' } } },
      }),
    ).toEqual({
      tier: 'free',
      tierName: 'Free Tier',
      isPaid: false,
    });
  });

  it('detects Pro tier via userTier.id or planInfo.teamsTier', () => {
    expect(detectAntigravityTier({ userTier: { id: 'pro' } })).toEqual({
      tier: 'pro',
      tierName: 'Google AI Pro',
      isPaid: true,
    });
    expect(detectAntigravityTier({ userTier: { id: 'pro-tier' } })).toEqual({
      tier: 'pro',
      tierName: 'Google AI Pro',
      isPaid: true,
    });
    expect(detectAntigravityTier({ planInfo: { teamsTier: 'TEAMS_TIER_PRO' } })).toEqual({
      tier: 'pro',
      tierName: 'Google AI Pro',
      isPaid: true,
    });
  });

  it('detects Ultra tier via userTier.id or planInfo.teamsTier', () => {
    expect(detectAntigravityTier({ userTier: { id: 'ultra' } })).toEqual({
      tier: 'ultra',
      tierName: 'Google AI Ultra',
      isPaid: true,
    });
    expect(detectAntigravityTier({ userTier: { id: 'ultra-tier' } })).toEqual({
      tier: 'ultra',
      tierName: 'Google AI Ultra',
      isPaid: true,
    });
    expect(detectAntigravityTier({ planInfo: { teamsTier: 'TEAMS_TIER_ULTRA' } })).toEqual({
      tier: 'ultra',
      tierName: 'Google AI Ultra',
      isPaid: true,
    });
  });

  it('prefers Ultra over Pro and Free when both match', () => {
    expect(
      detectAntigravityTier({
        userTier: { id: 'ultra-pro' },
      }),
    ).toEqual({
      tier: 'ultra',
      tierName: 'Google AI Ultra',
      isPaid: true,
    });
  });
});

describe('antigravitySourceWithTier', () => {
  it('surfaces detected tier name in header source', () => {
    expect(antigravitySourceWithTier('Google AI Pro')).toBe(
      'Antigravity Language Server (Google AI Pro)',
    );
    expect(antigravitySourceWithTier('Free Tier')).toBe(
      'Antigravity Language Server (Free Tier)',
    );
    expect(antigravitySourceWithTier('Google AI Ultra')).toBe(
      'Antigravity Language Server (Google AI Ultra)',
    );
  });

  it('falls back to default ANTIGRAVITY_QUOTA_SOURCE when tierName is null or empty', () => {
    expect(antigravitySourceWithTier(null)).toBe('Antigravity Language Server');
    expect(antigravitySourceWithTier('')).toBe('Antigravity Language Server');
  });
});

describe('windowDurationMinutes', () => {
  it('returns 300 minutes for 5-hour windows', () => {
    expect(windowDurationMinutes('5-hour')).toBe(300);
    expect(windowDurationMinutes('Gemini 5h')).toBe(300);
    expect(windowDurationMinutes('Claude/GPT (5-hour)')).toBe(300);
    expect(windowDurationMinutes('Argon (5-hour)')).toBe(300);
  });

  it('returns 10080 minutes for weekly windows', () => {
    expect(windowDurationMinutes('Weekly')).toBe(10080);
    expect(windowDurationMinutes('Claude/GPT (Weekly)')).toBe(10080);
    expect(windowDurationMinutes('Argon (Weekly)')).toBe(10080);
    expect(windowDurationMinutes('7-day')).toBe(10080);
  });

  it('returns Infinity for other or custom labels', () => {
    expect(windowDurationMinutes('Model')).toBe(Number.POSITIVE_INFINITY);
    expect(windowDurationMinutes('custom')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('resolveBucketLabel', () => {
  it('resolves Gemini rate-limit labels correctly to standard 5-hour and Weekly', () => {
    expect(resolveBucketLabel({ bucketId: 'gemini-5h' })).toBe('5-hour');
    expect(resolveBucketLabel({ bucketId: 'gemini-weekly' })).toBe('Weekly');
    expect(
      resolveBucketLabel(
        { window: '5h', displayName: '5h limit' },
        { displayName: 'Gemini Models' },
      ),
    ).toBe('5-hour');
    expect(
      resolveBucketLabel(
        { window: 'weekly', displayName: 'Weekly limit' },
        { displayName: 'Gemini Models' },
      ),
    ).toBe('Weekly');
    expect(
      resolveBucketLabel(
        { window: '5h' },
        { name: 'gemini_service' },
      ),
    ).toBe('5-hour');
    expect(
      resolveBucketLabel(
        { window: 'weekly' },
        { name: 'gemini_service' },
      ),
    ).toBe('Weekly');
  });

  it('resolves Claude and GPT 3P rate-limit labels correctly to standard Claude/GPT (Weekly)', () => {
    expect(resolveBucketLabel({ bucketId: '3p-5h' })).toBe('Claude/GPT (5-hour)');
    expect(resolveBucketLabel({ bucketId: '3p-weekly' })).toBe('Claude/GPT (Weekly)');
    expect(
      resolveBucketLabel(
        { window: '5h', displayName: '5h Limit' },
        { displayName: 'Claude and GPT models' },
      ),
    ).toBe('Claude/GPT (5-hour)');
    expect(
      resolveBucketLabel(
        { window: 'weekly', displayName: 'Weekly Limit' },
        { displayName: 'Claude and GPT models' },
      ),
    ).toBe('Claude/GPT (Weekly)');
    expect(
      resolveBucketLabel(
        { window: '5h' },
        { name: '3p_service' },
      ),
    ).toBe('Claude/GPT (5-hour)');
    expect(
      resolveBucketLabel(
        { window: 'weekly' },
        { name: '3p_service' },
      ),
    ).toBe('Claude/GPT (Weekly)');
  });

  it('resolves Argon rate-limit labels correctly to standard Argon (Weekly)', () => {
    expect(resolveBucketLabel({ bucketId: 'argon-weekly' })).toBe('Argon (Weekly)');
    expect(resolveBucketLabel({ bucketId: 'argon-5h' })).toBe('Argon (5-hour)');
    expect(
      resolveBucketLabel(
        { window: 'weekly', displayName: 'Weekly Limit' },
        { displayName: 'Gemini 4 Argon' },
      ),
    ).toBe('Argon (Weekly)');
    expect(
      resolveBucketLabel(
        { window: '5h', displayName: '5h Limit' },
        { displayName: 'Gemini 4 Argon' },
      ),
    ).toBe('Argon (5-hour)');
    expect(
      resolveBucketLabel(
        { window: 'weekly' },
        { name: 'argon_service' },
      ),
    ).toBe('Argon (Weekly)');
    expect(
      resolveBucketLabel(
        { window: '5h' },
        { name: 'argon_service' },
      ),
    ).toBe('Argon (5-hour)');
  });

  it('falls back to explicit label, bucketId, or "Model"', () => {
    expect(resolveBucketLabel({ label: 'Custom Window' })).toBe('Custom Window');
    expect(resolveBucketLabel({ displayName: 'Custom Display' })).toBe('Custom Display');
    expect(resolveBucketLabel({ bucketId: 'custom-pool' })).toBe('custom-pool');
    expect(resolveBucketLabel({})).toBe('Model');
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

  it('drops Prompt Credits, Flow Credits, and Monthly Plan Credits from windows', () => {
    const raw = {
      userStatus: {
        planStatus: {
          planInfo: {
            monthlyPromptCredits: 1000,
            availablePromptCredits: 350,
            monthlyFlowCredits: 200,
            availableFlowCredits: 50,
            monthlyPlanCredits: 500,
            availablePlanCredits: 100,
          },
        },
      },
    };
    expect(parseAntigravityWindows(raw)).toEqual([]);
  });

  it('omits non-time credit pools across all levels so no windows without reset timestamps appear', () => {
    expect(
      parseAntigravityWindows({
        planStatus: { monthlyPromptCredits: 100, availablePromptCredits: 20 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        userStatus: { monthlyFlowCredits: 100, availableFlowCredits: 50 },
      }),
    ).toEqual([]);
    expect(
      parseAntigravityWindows({
        monthlyPlanCredits: 500,
        availablePlanCredits: 100,
      }),
    ).toEqual([]);
  });

  it('sorts windows shortest duration first: 5-hour precedes Weekly and secondary weekly pools', () => {
    const summary = {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-weekly',
              window: 'weekly',
              remainingFraction: 0.2,
              resetTime: '2026-11-06T12:00:00Z',
              disabled: false,
            },
          ],
        },
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.5,
              resetTime: '2026-11-06T12:00:00Z',
              disabled: false,
            },
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.8,
              resetTime: '2026-10-30T14:00:00Z',
              disabled: false,
            },
          ],
        },
        {
          displayName: 'Gemini 4 Argon',
          buckets: [
            {
              bucketId: 'argon-weekly',
              window: 'weekly',
              remainingFraction: 0.4,
              resetTime: '2026-11-06T12:00:00Z',
              disabled: false,
            },
          ],
        },
      ],
    };
    const status = {
      planInfo: { teamsTier: 'TEAMS_TIER_PRO' },
    };
    const windows = parseAntigravityWindows(summary, status);
    expect(windows.map((w) => w.label)).toEqual([
      '5-hour',
      'Claude/GPT (Weekly)',
      'Weekly',
      'Argon (Weekly)',
    ]);
  });

  it('orders 5-hour before Weekly when Gemini group has Weekly listed before 5-hour', () => {
    const summary = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.5,
              resetTime: '2026-11-06T12:00:00Z',
              disabled: false,
            },
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.8,
              resetTime: '2026-10-30T14:00:00Z',
              disabled: false,
            },
          ],
        },
      ],
    };
    const windows = parseAntigravityWindows(summary, { planInfo: { teamsTier: 'TEAMS_TIER_FREE' } });
    expect(windows.map((w) => w.label)).toEqual(['5-hour', 'Weekly']);
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

  it('parses legacy clientModelConfigs in Free Tier keeping only Gemini rate limits', () => {
    const raw = {
      planInfo: { teamsTier: 'TEAMS_TIER_FREE' },
      clientModelConfigs: [
        {
          label: '5-hour',
          quotaInfo: { remainingFraction: 0.8 },
        },
        {
          label: 'Claude/GPT (Weekly)',
          quotaInfo: { remainingFraction: 0.5 },
        },
      ],
    };
    expect(parseAntigravityWindows(raw)).toEqual([
      { label: '5-hour', usedPct: 20, resetsAt: null },
    ]);
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

  it('Free Tier fixture: shows only active 5-hour & Weekly, suppressing Claude/GPT, Argon, and Monthly Credits', () => {
    const summary = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.8,
              resetTime: '2026-10-30T14:00:00Z',
              disabled: false,
            },
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.45,
              resetTime: '2026-11-06T12:00:00Z',
              disabled: false,
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-5h',
              window: '5h',
              remainingFraction: 0.0,
              resetTime: '2026-10-30T14:00:00Z',
              disabled: true,
            },
            {
              bucketId: '3p-weekly',
              window: 'weekly',
              remainingFraction: 0.5,
              resetTime: '2026-11-06T12:00:00Z',
              disabled: false,
            },
          ],
        },
        {
          displayName: 'Gemini 4 Argon',
          buckets: [
            {
              bucketId: 'argon-weekly',
              window: 'weekly',
              remainingFraction: 0.6,
              resetTime: '2026-11-06T12:00:00Z',
              disabled: false,
            },
          ],
        },
      ],
    };

    const status = {
      userStatus: {
        userTier: {
          id: 'free',
          name: 'Free Tier',
        },
        planStatus: {
          planInfo: {
            teamsTier: 'TEAMS_TIER_FREE',
            monthlyPromptCredits: 1000,
            availablePromptCredits: 500,
          },
        },
      },
    };

    const windows = parseAntigravityWindows(summary, status);
    expect(windows).toEqual([
      {
        label: '5-hour',
        usedPct: 20,
        resetsAt: '2026-10-30T14:00:00Z',
      },
      {
        label: 'Weekly',
        usedPct: 55,
        resetsAt: '2026-11-06T12:00:00Z',
      },
    ]);
  });

  it('Free Tier suppresses Gemini bucket when disabled: true', () => {
    const summary = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.0,
              disabled: true,
            },
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.3,
              resetTime: '2026-11-06T12:00:00Z',
              disabled: false,
            },
          ],
        },
      ],
    };
    const status = {
      planInfo: { teamsTier: 'TEAMS_TIER_FREE' },
    };
    const windows = parseAntigravityWindows(summary, status);
    expect(windows).toEqual([
      {
        label: 'Weekly',
        usedPct: 70,
        resetsAt: '2026-11-06T12:00:00Z',
      },
    ]);
  });

  it('Pro Tier fixture: shows 5-hour, Weekly, separated Claude/GPT (Weekly), Argon (Weekly); suppresses disabled: true (e.g. 3p-5h) and drops credits', () => {
    const summary = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.75,
              resetTime: '2026-10-30T14:00:00Z',
              disabled: false,
            },
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.5,
              resetTime: '2026-11-06T12:00:00Z',
              disabled: false,
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-5h',
              window: '5h',
              remainingFraction: 0.0,
              resetTime: '2026-10-30T14:00:00Z',
              disabled: true, // weekly limit reached -> disabled: true
            },
            {
              bucketId: '3p-weekly',
              window: 'weekly',
              remainingFraction: 0.3,
              resetTime: '2026-11-06T12:00:00Z',
              disabled: false,
            },
          ],
        },
        {
          displayName: 'Gemini 4 Argon',
          buckets: [
            {
              bucketId: 'argon-weekly',
              window: 'weekly',
              remainingFraction: 0.4,
              resetTime: '2026-11-06T12:00:00Z',
              disabled: false,
            },
          ],
        },
      ],
    };

    const status = {
      userStatus: {
        userTier: {
          id: 'pro',
          name: 'Google AI Pro',
        },
        planStatus: {
          planInfo: {
            teamsTier: 'TEAMS_TIER_PRO',
            monthlyPromptCredits: 1000,
            availablePromptCredits: 400,
            monthlyFlowCredits: 500,
            availableFlowCredits: 250,
          },
        },
      },
    };

    const windows = parseAntigravityWindows(summary, status);
    expect(windows).toEqual([
      {
        label: '5-hour',
        usedPct: 25,
        resetsAt: '2026-10-30T14:00:00Z',
      },
      {
        label: 'Weekly',
        usedPct: 50,
        resetsAt: '2026-11-06T12:00:00Z',
      },
      {
        label: 'Claude/GPT (Weekly)',
        usedPct: 70,
        resetsAt: '2026-11-06T12:00:00Z',
      },
      {
        label: 'Argon (Weekly)',
        usedPct: 60,
        resetsAt: '2026-11-06T12:00:00Z',
      },
    ]);
  });

  it('Pro Tier includes Claude/GPT (5-hour) when disabled is false', () => {
    const summary = {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-5h',
              window: '5h',
              remainingFraction: 0.9,
              resetTime: '2026-10-30T14:00:00Z',
              disabled: false,
            },
          ],
        },
      ],
    };
    const status = {
      planInfo: { teamsTier: 'TEAMS_TIER_PRO' },
    };
    const windows = parseAntigravityWindows(summary, status);
    expect(windows).toEqual([
      {
        label: 'Claude/GPT (5-hour)',
        usedPct: 10,
        resetsAt: '2026-10-30T14:00:00Z',
      },
    ]);
  });

  it('skips buckets without valid finite remainingFraction', () => {
    const summary = {
      groups: [
        {
          buckets: [
            { bucketId: 'gemini-5h', remainingFraction: 'invalid' },
            { bucketId: 'gemini-5h', remainingFraction: NaN },
            { bucketId: 'gemini-5h', remainingFraction: Infinity },
            null,
            'not-object',
          ],
        },
        null,
      ],
    };
    expect(parseAntigravityWindows(summary, {})).toEqual([]);
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
    expect(() =>
      writeCache('/dev/null/impossible/quota.json', {
        core: 'antigravity',
        state: 'ok',
        source: 'test',
        readAt: '2026-01-01T00:00:00.000Z',
        windows: [],
      }),
    ).not.toThrow();
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

      writeFileSync(testPath, JSON.stringify({ core: 'codex', state: 'ok', windows: [], readAt: '2026-10-29T10:00:00.000Z' }));
      expect(await readCache(testPath, 0, 1000)).toBeNull();

      writeFileSync(testPath, JSON.stringify({ core: 'antigravity', state: 'unknown', windows: [], readAt: '2026-10-29T10:00:00.000Z' }));
      expect(await readCache(testPath, 0, 1000)).toBeNull();

      writeFileSync(testPath, JSON.stringify({ core: 'antigravity', state: 'ok', windows: 'none', readAt: '2026-10-29T10:00:00.000Z' }));
      expect(await readCache(testPath, 0, 1000)).toBeNull();

      writeFileSync(testPath, JSON.stringify({ core: 'antigravity', state: 'ok', windows: [] }));
      expect(await readCache(testPath, 0, 1000)).toBeNull();

      writeFileSync(testPath, JSON.stringify({ core: 'antigravity', state: 'ok', windows: [], readAt: 123 }));
      expect(await readCache(testPath, 0, 1000)).toBeNull();

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

      const resBoundary = await readCache(cachePath, readAtMs + ttlMs, ttlMs);
      expect(resBoundary).not.toBeNull();

      const resExpired = await readCache(cachePath, readAtMs + ttlMs + 1, ttlMs);
      expect(resExpired).toBeNull();

      const resFuture = await readCache(cachePath, readAtMs - 1000, ttlMs);
      expect(resFuture).toBeNull();

      writeFileSync(
        cachePath,
        JSON.stringify({
          core: 'antigravity',
          state: 'ok',
          windows: [{ label: 'W', usedPct: 5, resetsAt: null }],
          source: 'Antigravity Language Server (Google AI Pro)',
          readAt,
        }),
      );
      const resCustom = await readCache(cachePath, readAtMs, ttlMs);
      expect(resCustom?.source).toBe('Antigravity Language Server (Google AI Pro)');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe('antigravityQuotaReader', () => {
  function createTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'karst-test-antigravity-'));
  }

  it('makes live POST requests to RetrieveUserQuotaSummary and GetUserStatus with required headers and writes atomic cache (Pro Tier)', async () => {
    const appDataDir = createTempDir();
    try {
      const capturedCalls: { url: string; options: RequestInit | undefined }[] = [];

      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        capturedCalls.push({ url: urlStr, options: init });

        if (urlStr.endsWith('RetrieveUserQuotaSummary')) {
          return new Response(
            JSON.stringify({
              groups: [
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    {
                      bucketId: 'gemini-5h',
                      window: '5h',
                      remainingFraction: 0.8,
                      resetTime: '2026-10-30T14:00:00Z',
                      disabled: false,
                    },
                    {
                      bucketId: 'gemini-weekly',
                      window: 'weekly',
                      remainingFraction: 0.5,
                      resetTime: '2026-11-06T12:00:00Z',
                      disabled: false,
                    },
                  ],
                },
                {
                  displayName: 'Claude and GPT models',
                  buckets: [
                    {
                      bucketId: '3p-5h',
                      window: '5h',
                      remainingFraction: 0.0,
                      resetTime: '2026-10-30T14:00:00Z',
                      disabled: true,
                    },
                    {
                      bucketId: '3p-weekly',
                      window: 'weekly',
                      remainingFraction: 0.2,
                      resetTime: '2026-11-06T12:00:00Z',
                      disabled: false,
                    },
                  ],
                },
                {
                  displayName: 'Gemini 4 Argon',
                  buckets: [
                    {
                      bucketId: 'argon-weekly',
                      window: 'weekly',
                      remainingFraction: 0.4,
                      resetTime: '2026-11-06T12:00:00Z',
                      disabled: false,
                    },
                  ],
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (urlStr.endsWith('GetUserStatus')) {
          return new Response(
            JSON.stringify({
              userStatus: {
                userTier: {
                  id: 'pro',
                  name: 'Google AI Pro',
                },
                planStatus: {
                  planInfo: {
                    teamsTier: 'TEAMS_TIER_PRO',
                    monthlyPromptCredits: 1000,
                    availablePromptCredits: 400,
                    monthlyFlowCredits: 500,
                    availableFlowCredits: 250,
                  },
                },
              },
            }),
            { status: 200 },
          );
        }

        return new Response('Not found', { status: 404 });
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

      expect(fetchImpl).toHaveBeenCalledTimes(2);

      const urls = capturedCalls.map((c) => c.url);
      expect(urls).toContain(
        'http://127.0.0.1:45123/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      );
      expect(urls).toContain(
        'http://127.0.0.1:45123/exa.language_server_pb.LanguageServerService/GetUserStatus',
      );

      for (const call of capturedCalls) {
        expect(call.options?.method).toBe('POST');
        expect(call.options?.body).toBe('{}');
        expect(call.options?.headers).toEqual({
          'Connect-Protocol-Version': '1',
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': 'secret-csrf-token-xyz',
        });
        expect(call.options?.signal).toBeDefined();
      }

      expect(snapshot).toEqual({
        core: 'antigravity',
        state: 'ok',
        source: 'Antigravity Language Server (Google AI Pro)',
        readAt: '2026-10-29T10:00:00.000Z',
        windows: [
          { label: '5-hour', usedPct: 20, resetsAt: '2026-10-30T14:00:00Z' },
          { label: 'Weekly', usedPct: 50, resetsAt: '2026-11-06T12:00:00Z' },
          { label: 'Claude/GPT (Weekly)', usedPct: 80, resetsAt: '2026-11-06T12:00:00Z' },
          { label: 'Argon (Weekly)', usedPct: 60, resetsAt: '2026-11-06T12:00:00Z' },
        ],
      });

      const cachePath = join(appDataDir, 'cache', 'quota.json');
      expect(existsSync(cachePath)).toBe(true);

      const cachedRaw = readFileSync(cachePath, 'utf8');
      const cached = JSON.parse(cachedRaw);
      expect(cached).toEqual(snapshot);

      expect(cachedRaw).not.toContain('secret-csrf-token-xyz');
      expect(cachedRaw).not.toContain('ANTIGRAVITY_CSRF_TOKEN');
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('makes live POST requests and formats Free Tier source and active Gemini windows', async () => {
    const appDataDir = createTempDir();
    try {
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.endsWith('RetrieveUserQuotaSummary')) {
          return new Response(
            JSON.stringify({
              groups: [
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    {
                      bucketId: 'gemini-5h',
                      window: '5h',
                      remainingFraction: 0.9,
                      resetTime: '2026-10-30T14:00:00Z',
                      disabled: false,
                    },
                    {
                      bucketId: 'gemini-weekly',
                      window: 'weekly',
                      remainingFraction: 0.7,
                      resetTime: '2026-11-06T12:00:00Z',
                      disabled: false,
                    },
                  ],
                },
                {
                  displayName: 'Claude and GPT models',
                  buckets: [
                    {
                      bucketId: '3p-weekly',
                      window: 'weekly',
                      remainingFraction: 0.5,
                      disabled: false,
                    },
                  ],
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (urlStr.endsWith('GetUserStatus')) {
          return new Response(
            JSON.stringify({
              userStatus: {
                userTier: {
                  id: 'free',
                  name: 'Free Tier',
                },
                planStatus: {
                  planInfo: {
                    teamsTier: 'TEAMS_TIER_FREE',
                    monthlyPromptCredits: 100,
                    availablePromptCredits: 50,
                  },
                },
              },
            }),
            { status: 200 },
          );
        }

        return new Response('Not found', { status: 404 });
      }) as unknown as typeof fetch;

      const reader = antigravityQuotaReader({
        appDataDir,
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: 'free-token',
        },
        now: () => new Date('2026-10-29T10:00:00.000Z'),
        fetchImpl,
      });

      const snapshot = await reader.read();
      expect(snapshot).toEqual({
        core: 'antigravity',
        state: 'ok',
        source: 'Antigravity Language Server (Free Tier)',
        readAt: '2026-10-29T10:00:00.000Z',
        windows: [
          { label: '5-hour', usedPct: 10, resetsAt: '2026-10-30T14:00:00Z' },
          { label: 'Weekly', usedPct: 30, resetsAt: '2026-11-06T12:00:00Z' },
        ],
      });
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('makes live POST requests and formats Ultra Tier source', async () => {
    const appDataDir = createTempDir();
    try {
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.endsWith('RetrieveUserQuotaSummary')) {
          return new Response(
            JSON.stringify({
              groups: [
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    {
                      bucketId: 'gemini-5h',
                      remainingFraction: 0.9,
                    },
                  ],
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            userStatus: {
              userTier: { id: 'ultra' },
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const reader = antigravityQuotaReader({
        appDataDir,
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: 'ultra-token',
        },
        now: () => new Date('2026-10-29T10:00:00.000Z'),
        fetchImpl,
      });

      const snapshot = await reader.read();
      expect(snapshot.state).toBe('ok');
      if (snapshot.state === 'ok') {
        expect(snapshot.source).toBe('Antigravity Language Server (Google AI Ultra)');
      }
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('falls back to cache within 24h TTL and preserves readAt and source when live call fails', async () => {
    const appDataDir = createTempDir();
    try {
      const cachePath = join(appDataDir, 'cache', 'quota.json');
      mkdirSync(join(appDataDir, 'cache'), { recursive: true });

      const cachedSnapshot: QuotaKnown = {
        core: 'antigravity',
        state: 'ok',
        source: 'Antigravity Language Server (Google AI Pro)',
        readAt: '2026-10-28T12:00:00.000Z',
        windows: [{ label: '5-hour', usedPct: 40, resetsAt: '2026-10-28T17:00:00.000Z' }],
      };
      writeFileSync(cachePath, JSON.stringify(cachedSnapshot), 'utf8');

      const fetchImpl = vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:45123');
      }) as unknown as typeof fetch;

      const now = () => new Date('2026-10-28T22:00:00.000Z');

      const reader = antigravityQuotaReader({
        appDataDir,
        cacheTtlMs: 86_400_000,
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: 'token',
        },
        now,
        fetchImpl,
      });

      const snapshot = await reader.read();
      expect(fetchImpl).toHaveBeenCalled();
      expect(snapshot).toEqual(cachedSnapshot);
      expect(snapshot.state).toBe('ok');
      if (snapshot.state === 'ok') {
        expect(snapshot.readAt).toBe('2026-10-28T12:00:00.000Z');
        expect(snapshot.source).toBe('Antigravity Language Server (Google AI Pro)');
      }
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('reports friendly unknown reason when address or token is missing and no server running', async () => {
    const appDataDir = createTempDir();
    try {
      const readerMissing = antigravityQuotaReader({
        appDataDir,
        env: { ANTIGRAVITY_CSRF_TOKEN: 'csrf-only' },
        now: () => new Date(0),
        listProcesses: () => [],
      });
      expect(await readerMissing.read()).toEqual({
        core: 'antigravity',
        state: 'unknown',
        reason: ANTIGRAVITY_NOT_RUNNING_REASON,
      });

      const readerEmpty = antigravityQuotaReader({
        appDataDir,
        env: { ANTIGRAVITY_LS_ADDRESS: '', ANTIGRAVITY_CSRF_TOKEN: 'csrf-only' },
        now: () => new Date(0),
        listProcesses: () => [],
      });
      expect(await readerEmpty.read()).toEqual({
        core: 'antigravity',
        state: 'unknown',
        reason: ANTIGRAVITY_NOT_RUNNING_REASON,
      });
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('reports friendly unknown reason when token is missing/empty and no server running', async () => {
    const appDataDir = createTempDir();
    try {
      const readerMissing = antigravityQuotaReader({
        appDataDir,
        env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123' },
        now: () => new Date(0),
        listProcesses: () => [],
      });
      expect(await readerMissing.read()).toEqual({
        core: 'antigravity',
        state: 'unknown',
        reason: ANTIGRAVITY_NOT_RUNNING_REASON,
      });

      const readerEmpty = antigravityQuotaReader({
        appDataDir,
        env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123', ANTIGRAVITY_CSRF_TOKEN: '' },
        now: () => new Date(0),
        listProcesses: () => [],
      });
      expect(await readerEmpty.read()).toEqual({
        core: 'antigravity',
        state: 'unknown',
        reason: ANTIGRAVITY_NOT_RUNNING_REASON,
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
        reason: ANTIGRAVITY_UNRESPONSIVE_REASON,
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
        reason: ANTIGRAVITY_UNRESPONSIVE_REASON,
      });
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('resolves appDataDir using injected appDataDir or injected homeDir', async () => {
    const fakeHome = createTempDir();
    const fakeAppData = createTempDir();
    try {
      const readerWithHome = antigravityQuotaReader({
        homeDir: fakeHome,
        env: {},
        now: () => new Date(0),
      });
      const snap1 = await readerWithHome.read();
      expect(snap1.core).toBe('antigravity');
      expect(snap1.state).toBe('unknown');

      const readerWithAppData = antigravityQuotaReader({
        appDataDir: fakeAppData,
        env: {},
        now: () => new Date(0),
      });
      const snap2 = await readerWithAppData.read();
      expect(snap2.core).toBe('antigravity');
      expect(snap2.state).toBe('unknown');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(fakeAppData, { recursive: true, force: true });
    }
  });

  it('reader with empty env + fake discovered server produces ok snapshot and writes cache', async () => {
    const appDataDir = createTempDir();
    try {
      const fetchImpl = vi.fn().mockImplementation((url: string) => {
        if (url.includes('RetrieveUserQuotaSummary')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                groups: [
                  {
                    name: 'gemini',
                    buckets: [
                      {
                        bucketId: 'gemini-5h',
                        window: '5h',
                        remainingFraction: 0.8,
                        resetTime: '2026-10-31T15:00:00Z',
                      },
                    ],
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes('GetUserStatus')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                userStatus: {
                  userTier: { id: 'g1-pro-tier' },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      }) as unknown as typeof fetch;

      const reader = antigravityQuotaReader({
        appDataDir,
        env: {},
        now: () => new Date('2026-10-31T12:00:00.000Z'),
        fetchImpl,
        listProcesses: () => [
          {
            pid: 999,
            command: 'language_server --csrf_token discovered-csrf --http_server_port 57687',
          },
        ],
      });

      const snapshot = await reader.read();
      expect(snapshot).toEqual({
        core: 'antigravity',
        state: 'ok',
        windows: [
          {
            label: '5-hour',
            usedPct: 20,
            resetsAt: '2026-10-31T15:00:00Z',
          },
        ],
        source: 'Antigravity Language Server (Google AI Pro)',
        readAt: '2026-10-31T12:00:00.000Z',
      });

      const cachePath = join(appDataDir, 'cache', 'quota.json');
      const cachedContent = JSON.parse(readFileSync(cachePath, 'utf8'));
      expect(cachedContent.state).toBe('ok');
      expect(cachedContent.windows[0].label).toBe('5-hour');
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('no server running returns friendly unknown reason', async () => {
    const appDataDir = createTempDir();
    try {
      const reader = antigravityQuotaReader({
        appDataDir,
        env: {},
        listProcesses: () => [],
        readFile: () => null,
      });

      const snapshot = await reader.read();
      expect(snapshot).toEqual({
        core: 'antigravity',
        state: 'unknown',
        reason: ANTIGRAVITY_NOT_RUNNING_REASON,
      });
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('env vars take priority over discovered server', async () => {
    const appDataDir = createTempDir();
    try {
      const fetchUrls: string[] = [];
      const fetchHeaders: Array<Record<string, string>> = [];
      const fetchImpl = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        fetchUrls.push(url);
        fetchHeaders.push((init?.headers ?? {}) as Record<string, string>);
        if (url.includes('RetrieveUserQuotaSummary')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                groups: [
                  {
                    name: 'gemini',
                    buckets: [
                      {
                        bucketId: 'gemini-5h',
                        window: '5h',
                        remainingFraction: 0.5,
                        resetTime: '2026-10-31T15:00:00Z',
                      },
                    ],
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ userStatus: {} }), { status: 200 }));
      }) as unknown as typeof fetch;

      const reader = antigravityQuotaReader({
        appDataDir,
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: 'env-csrf-token',
        },
        fetchImpl,
        listProcesses: () => [
          {
            pid: 999,
            command: 'language_server --csrf_token ignored-csrf --http_server_port 57687',
          },
        ],
      });

      const snapshot = await reader.read();
      expect(snapshot.state).toBe('ok');
      expect(fetchUrls[0]).toContain('127.0.0.1:45123');
      expect(fetchHeaders[0]?.['x-codeium-csrf-token']).toBe('env-csrf-token');
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  it('csrf token never appears in snapshot, errors, or cached files', async () => {
    const appDataDir = createTempDir();
    const secretToken = 'super-secret-token-never-leak-999';
    try {
      const fetchImpl = vi.fn().mockImplementation((url: string) => {
        if (url.includes('RetrieveUserQuotaSummary')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                groups: [
                  {
                    name: 'gemini',
                    buckets: [
                      {
                        bucketId: 'gemini-5h',
                        window: '5h',
                        remainingFraction: 0.9,
                      },
                    ],
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ userStatus: {} }), { status: 200 }));
      }) as unknown as typeof fetch;

      const reader = antigravityQuotaReader({
        appDataDir,
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
          ANTIGRAVITY_CSRF_TOKEN: secretToken,
        },
        fetchImpl,
      });

      const snapshot = await reader.read();
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(secretToken);

      const cachePath = join(appDataDir, 'cache', 'quota.json');
      const cachedRaw = readFileSync(cachePath, 'utf8');
      expect(cachedRaw).not.toContain(secretToken);

      const failingFetch = vi.fn().mockRejectedValue(new Error(`Failed with ${secretToken}`));
      const failingAppDataDir = createTempDir();
      try {
        const failingReader = antigravityQuotaReader({
          appDataDir: failingAppDataDir,
          env: {
            ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:45123',
            ANTIGRAVITY_CSRF_TOKEN: secretToken,
          },
          fetchImpl: failingFetch,
        });
        const failSnapshot = await failingReader.read();
        expect(JSON.stringify(failSnapshot)).not.toContain(secretToken);
      } finally {
        rmSync(failingAppDataDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });
});
