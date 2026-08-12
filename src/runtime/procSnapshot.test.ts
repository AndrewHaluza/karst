import { describe, expect, it, vi } from 'vitest';
import {
  parseCpuTime,
  parseProcTable,
  readProcSnapshot,
  PROC_SNAPSHOT_TIMEOUT_MS,
} from './procSnapshot.js';

/** Verbatim `ps -Ao pid=,ppid=,rss=,time=,lstart=,comm=` captured on macOS. */
const MACOS_SAMPLE = [
  '  624     1  20432   7:33.58 Thu Aug  6 08:59:22 2026     /System/Library/CoreServices/Spotlight.app/Contents/MacOS/Spotlight',
  ' 1144     1   2384   0:06.68 Thu Aug  6 09:01:30 2026     /System/Library/Frameworks/CoreSpotlight.framework/spotlightknowledged',
  ' 4571     1   6304   0:07.14 Tue Aug 11 00:46:44 2026     /Users/nd/.nvm/versions/node/v22.22.0/bin/node',
].join('\n');

/** Verbatim-shaped `ps -Ao pid=,ppid=,rss=,time=,lstart=,comm=` output on GNU/Linux. */
const LINUX_SAMPLE = [
  '    1     0   8912  00:00:42 Wed Aug 12 08:00:00 2026 systemd',
  '    2     0      0  00:00:00 Wed Aug 12 08:00:00 2026 kthreadd',
  '  412     1 126788  00:04:51 Wed Aug 12 08:00:01 2026 postgres',
].join('\n');

describe('parseCpuTime', () => {
  it('parses MM:SS.ss', () => {
    expect(parseCpuTime('0:00.42')).toBeCloseTo(0.42, 6);
  });

  it('parses MM:SS', () => {
    expect(parseCpuTime('12:03')).toBe(723);
  });

  it('parses HH:MM:SS', () => {
    expect(parseCpuTime('1:02:03')).toBe(3723);
  });

  it('parses D-HH:MM:SS', () => {
    expect(parseCpuTime('2-03:04:05')).toBe(2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
  });

  it('returns null for garbage', () => {
    expect(parseCpuTime('abc')).toBeNull();
    expect(parseCpuTime('1:2:x')).toBeNull();
  });
});

describe('parseProcTable', () => {
  it('parses a verbatim 3-line macOS sample', () => {
    const snap = parseProcTable(MACOS_SAMPLE, 1_000);
    expect(snap.records.size).toBe(3);
    expect(snap.records.get(624)).toMatchObject({
      pid: 624,
      ppid: 1,
      rssBytes: 20_432 * 1024,
      cpuSeconds: 453.58,
      startedMs: Date.parse('Thu Aug 6 08:59:22 2026'),
      comm: '/System/Library/CoreServices/Spotlight.app/Contents/MacOS/Spotlight',
    });
    expect(snap.records.get(1144)).toMatchObject({
      pid: 1144,
      rssBytes: 2_384 * 1024,
      cpuSeconds: 6.68,
      startedMs: Date.parse('Thu Aug 6 09:01:30 2026'),
    });
    expect(snap.records.get(4571)).toMatchObject({
      pid: 4571,
      rssBytes: 6_304 * 1024,
      cpuSeconds: 7.14,
      startedMs: Date.parse('Tue Aug 11 00:46:44 2026'),
      comm: '/Users/nd/.nvm/versions/node/v22.22.0/bin/node',
    });
  });

  it('parses a verbatim GNU/Linux sample (zero-rss kernel thread kept)', () => {
    const snap = parseProcTable(LINUX_SAMPLE, 2_000);
    expect(snap.records.size).toBe(3);
    expect(snap.records.get(1)).toMatchObject({
      pid: 1,
      ppid: 0,
      rssBytes: 8_912 * 1024,
      cpuSeconds: 42,
      comm: 'systemd',
    });
    expect(snap.records.get(2)).toMatchObject({
      pid: 2,
      ppid: 0,
      rssBytes: 0,
      cpuSeconds: 0,
      comm: 'kthreadd',
    });
    expect(snap.records.get(412)).toMatchObject({
      pid: 412,
      ppid: 1,
      rssBytes: 126_788 * 1024,
      cpuSeconds: 4 * 60 + 51,
      comm: 'postgres',
    });
  });

  it('round-trips a comm containing spaces', () => {
    const snap = parseProcTable(
      '  900     1  20432   1:02.03 Thu Aug  6 08:59:22 2026     Google Chrome Helper',
      0,
    );
    expect(snap.records.get(900)?.comm).toBe('Google Chrome Helper');
  });

  it('skips a short line (9 tokens) without throwing', () => {
    const snap = parseProcTable(
      '  900     1  20432   1:02.03 Thu Aug  6 08:59:22 2026',
      0,
    );
    expect(snap.records.size).toBe(0);
  });

  it('keeps a record whose lstart did not parse with startedMs === null', () => {
    const snap = parseProcTable(
      '  901     1  20432   1:02.03 Thu bogus bogus bogus bogus     sshd',
      0,
    );
    expect(snap.records.get(901)).toMatchObject({
      pid: 901,
      startedMs: null,
      comm: 'sshd',
    });
  });

  it('skips a line whose time field is malformed', () => {
    const snap = parseProcTable('  902     1  20432   abc Thu Aug  6 08:59:22 2026     sshd', 0);
    expect(snap.records.size).toBe(0);
  });

  it('builds the children index from the ppid column', () => {
    const lines = [
      '  500     1  1000   0:00.01 Tue Aug 12 10:00:00 2026     leader',
      '  501   500  1000   0:00.01 Tue Aug 12 10:00:01 2026     child-a',
      '  502   500  1000   0:00.01 Tue Aug 12 10:00:01 2026     child-b',
    ].join('\n');
    const snap = parseProcTable(lines, 0);
    expect(snap.children.get(500)).toEqual([501, 502]);
  });

  it('handles empty stdout as empty maps, not null', () => {
    const snap = parseProcTable('', 0);
    expect(snap.records.size).toBe(0);
    expect(snap.children.size).toBe(0);
  });
});

describe('readProcSnapshot', () => {
  it('returns unsupported on win32 without ever calling the runner', async () => {
    const run = vi.fn();
    const result = await readProcSnapshot(() => 0, 'win32', run as never);
    expect(result).toEqual({ supported: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('returns { supported: true, snapshot: null } when ps did not answer', async () => {
    const result = await readProcSnapshot(() => 0, 'darwin', async () => null);
    expect(result).toEqual({ supported: true, snapshot: null });
  });

  it('passes the exact command, args and timeout to the runner', async () => {
    const run = vi.fn(async () => MACOS_SAMPLE);
    const result = await readProcSnapshot(() => 1_234, 'linux', run as never);
    expect(result.supported).toBe(true);
    expect(run).toHaveBeenCalledWith(
      'ps',
      ['-Ao', 'pid=,ppid=,rss=,time=,lstart=,comm='],
      PROC_SNAPSHOT_TIMEOUT_MS,
    );
    if (!result.supported) throw new Error('expected a supported snapshot');
    expect(result.snapshot?.takenMs).toBe(1_234);
  });
});
