import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigDir, parseClaudeRateLimits, readClaudeQuota } from './claude.js';

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
  it('reports unknown when no cache exists', () => {
    const snap = readClaudeQuota({ homeDir: home, now: () => NOW });
    expect(snap).toMatchObject({ core: 'claude', state: 'unknown' });
    expect(snap.state === 'unknown' && snap.reason).toMatch(/statusline quota cache/);
  });

  it('reports unknown for an unparseable cache', () => {
    const dir = join(home, '.claude', 'cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'quota.json'), '{ not json');
    const snap = readClaudeQuota({ homeDir: home, now: () => NOW });
    expect(snap.state === 'unknown' && snap.reason).toMatch(/could not be parsed/);
  });

  it('reports the windows from the cached statusline payload', () => {
    writeCache(STATUSLINE);
    const snap = readClaudeQuota({ homeDir: home, now: () => NOW });
    expect(snap).toMatchObject({ core: 'claude', state: 'ok', source: 'Claude statusline telemetry' });
    expect(snap.state === 'ok' && snap.windows.map((w) => w.label)).toEqual(['5-hour', '7-day']);
  });

  it('honors CLAUDE_CONFIG_DIR for the cache location', () => {
    const custom = join(home, 'custom-claude');
    writeCache(STATUSLINE, custom);
    const snap = readClaudeQuota({ homeDir: home, env: { CLAUDE_CONFIG_DIR: custom }, now: () => NOW });
    expect(snap.state).toBe('ok');
  });
});
