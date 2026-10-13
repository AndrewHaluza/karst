import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLatestCodexSessionFile,
  parseCodexRateLimits,
  readCodexQuota,
  readCodexRateLimitsFrom,
  windowLabel,
} from './codex.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'karst-codex-quota-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function sessionLine(payload: unknown): string {
  return JSON.stringify({ type: 'event_msg', payload });
}

function writeSession(lines: string[], name = 'rollout-2026-01-01T00-00-00-abc.jsonl'): string {
  const dir = join(home, '.codex', 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

const RATE_LIMITS = {
  limit_id: 'codex',
  primary: { used_percent: 76, window_minutes: 43200, resets_at: 1793635607 },
  secondary: { used_percent: 24, window_minutes: 10080, resets_at: 1793700000 },
  credits: { has_credits: false, unlimited: false, balance: null },
  plan_type: 'pro',
};

describe('windowLabel', () => {
  it('names a whole-day window in days', () => {
    expect(windowLabel(10080, 'primary')).toBe('7-day');
    expect(windowLabel(43200, 'primary')).toBe('30-day');
  });
  it('names an hours window in hours and a fallback otherwise', () => {
    expect(windowLabel(300, 'primary')).toBe('5-hour');
    expect(windowLabel(90, 'primary')).toBe('90-min');
  });
  it('falls back when the length is absent or non-positive', () => {
    expect(windowLabel(null, 'primary')).toBe('primary');
    expect(windowLabel(0, 'secondary')).toBe('secondary');
  });
});

describe('parseCodexRateLimits', () => {
  it('maps primary and secondary to windows', () => {
    expect(parseCodexRateLimits(RATE_LIMITS)).toEqual([
      { label: '30-day', usedPct: 76, resetsAt: new Date(1793635607 * 1000).toISOString() },
      { label: '7-day', usedPct: 24, resetsAt: new Date(1793700000 * 1000).toISOString() },
    ]);
  });

  it('skips a window whose used_percent is not a number — never a fake 0%', () => {
    expect(
      parseCodexRateLimits({ primary: { window_minutes: 300 }, secondary: { used_percent: 24, window_minutes: 10080 } }),
    ).toEqual([{ label: '7-day', usedPct: 24, resetsAt: null }]);
  });

  it('clamps a used_percent outside 0–100', () => {
    expect(parseCodexRateLimits({ primary: { used_percent: 140, window_minutes: 300 } })[0]!.usedPct).toBe(100);
    expect(parseCodexRateLimits({ primary: { used_percent: -5, window_minutes: 300 } })[0]!.usedPct).toBe(0);
  });

  it('returns [] for a non-object or a null window', () => {
    expect(parseCodexRateLimits(null)).toEqual([]);
    expect(parseCodexRateLimits({ primary: null })).toEqual([]);
  });
});

describe('readCodexRateLimitsFrom', () => {
  it('reads the LAST rate-limits line from the tail', () => {
    const text = [
      sessionLine({ rate_limits: { primary: { used_percent: 10 } } }),
      'not json',
      sessionLine({ other: true }),
      sessionLine({ rate_limits: RATE_LIMITS }),
    ].join('\n');
    expect(readCodexRateLimitsFrom(text)).toEqual(RATE_LIMITS);
  });

  it('returns null when no line carries rate_limits', () => {
    expect(readCodexRateLimitsFrom(sessionLine({ foo: 1 }))).toBeNull();
  });
});

describe('findLatestCodexSessionFile', () => {
  it('picks the newest rollout file by mtime', () => {
    const first = writeSession([sessionLine({})], 'rollout-old.jsonl');
    const second = writeSession([sessionLine({})], 'rollout-new.jsonl');
    // mtime resolution can tie; pin the two explicitly.
    utimesSync(first, new Date(1_000_000), new Date(1_000_000));
    utimesSync(second, new Date(2_000_000), new Date(2_000_000));
    expect(findLatestCodexSessionFile(join(home, '.codex', 'sessions'))).toBe(second);
  });

  it('returns null when the sessions dir is absent', () => {
    expect(findLatestCodexSessionFile(join(home, 'nope'))).toBeNull();
  });
});

describe('readCodexQuota', () => {
  it('reports unknown when no session file exists', () => {
    const snap = readCodexQuota({ homeDir: home, now: () => NOW });
    expect(snap).toMatchObject({ core: 'codex', state: 'unknown' });
    expect(snap.state === 'unknown' && snap.reason).toMatch(/no Codex session files/);
  });

  it('reports unknown when the session carries no rate limits yet', () => {
    writeSession([sessionLine({ type: 'token_count' })]);
    const snap = readCodexQuota({ homeDir: home, now: () => NOW });
    expect(snap).toMatchObject({ core: 'codex', state: 'unknown' });
  });

  it('reports the windows with provenance and readAt', () => {
    writeSession([sessionLine({ rate_limits: RATE_LIMITS })]);
    const snap = readCodexQuota({ homeDir: home, now: () => NOW });
    expect(snap).toMatchObject({
      core: 'codex',
      state: 'ok',
      source: 'Codex session rate limits',
      readAt: NOW.toISOString(),
    });
    expect(snap.state === 'ok' && snap.windows.map((w) => w.usedPct)).toEqual([76, 24]);
  });
});
