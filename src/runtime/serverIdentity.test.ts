import { describe, it, expect } from 'vitest';
import {
  attributeServer,
  parseStartedAt,
  type ProcessFacts,
  type LiveCwd,
} from './serverIdentity.js';

const RECORDED_START = Date.parse('2026-08-03T07:00:00.000Z');

function facts(over: Partial<ProcessFacts> = {}): ProcessFacts {
  return {
    isAlive: () => true,
    liveCwd: (): LiveCwd | null => null,
    processStartMs: () => RECORDED_START,
    ...over,
  };
}

describe('parseStartedAt', () => {
  it('reads an ISO timestamp', () => {
    expect(parseStartedAt('2026-08-03T07:00:00.000Z')).toBe(RECORDED_START);
  });

  it('is null for nothing and for nonsense', () => {
    expect(parseStartedAt(null)).toBeNull();
    expect(parseStartedAt('not a date')).toBeNull();
  });
});

describe('attributeServer', () => {
  const row = { pid: 4242, cwd: '/w/abc', startedAt: '2026-08-03T07:00:00.000Z' };

  it('is dead when nothing runs under the pid', () => {
    expect(attributeServer(row, facts({ isAlive: () => false }))).toBe('dead');
  });

  it('is unknown when the row never recorded a pid', () => {
    expect(attributeServer({ ...row, pid: null }, facts())).toBe('unknown');
  });

  describe('with a cwd probe (Linux /proc)', () => {
    it('attributes a live process whose cwd is the recorded one', () => {
      const f = facts({ liveCwd: () => ({ path: '/w/abc', deleted: false }) });
      expect(attributeServer(row, f)).toBe('attributable');
    });

    it('still attributes it once the directory is deleted — that IS the orphan', () => {
      const f = facts({ liveCwd: () => ({ path: '/w/abc', deleted: true }) });
      expect(attributeServer(row, f)).toBe('attributable');
    });

    it('refuses a live pid running somewhere else — a reissued pid', () => {
      const f = facts({ liveCwd: () => ({ path: '/somewhere/else', deleted: false }) });
      expect(attributeServer(row, f)).toBe('foreign');
    });

    it('refuses when the row has no recorded directory to compare against', () => {
      const f = facts({ liveCwd: () => ({ path: '/w/abc', deleted: false }) });
      expect(attributeServer({ ...row, cwd: null }, f)).toBe('unknown');
    });

    // The kernel's /proc/<pid>/cwd is always the fully resolved path, so a raw
    // string compare against a recorded cwd that still carries a symlinked
    // component (e.g. macOS /var -> /private/var, or a symlinked workspace
    // root on Linux) reads the SAME directory as a different one — and the
    // orphan this probe exists to catch would never match. Both sides must be
    // canonicalized before comparing.
    it('matches through a symlinked component in the recorded cwd', () => {
      const f = facts({ liveCwd: () => ({ path: '/private/var/w/abc', deleted: false }) });
      expect(attributeServer({ ...row, cwd: '/var/w/abc' }, f)).toBe('attributable');
    });

    // The probe answers before start time is ever consulted: a process whose
    // start time would not match can still be attributed if the OS itself
    // confirms it is running in the recorded directory.
    it('outranks the start-time rule', () => {
      const f = facts({
        liveCwd: () => ({ path: '/w/abc', deleted: true }),
        processStartMs: () => RECORDED_START + 999_999,
      });
      expect(attributeServer(row, f)).toBe('attributable');
    });
  });

  describe('without a cwd probe (macOS, Windows)', () => {
    it('attributes a live pid whose own start time matches the recorded one', () => {
      expect(attributeServer(row, facts())).toBe('attributable');
    });

    it('tolerates sub-second rounding from a whole-second probe (e.g. `ps lstart`)', () => {
      expect(
        attributeServer(row, facts({ processStartMs: () => RECORDED_START + 900 })),
      ).toBe('attributable');
    });

    // This is the fix for relying on boot time alone: two servers started
    // seconds apart, within the SAME boot, must not be confused for each
    // other — a reused pid whose actual start time differs is refused, not
    // waved through because "it started after boot".
    it('refuses a live pid whose actual start time does not match, even within the same boot', () => {
      expect(
        attributeServer(row, facts({ processStartMs: () => RECORDED_START + 3600_000 })),
      ).toBe('foreign');
    });

    it('refuses when the platform cannot report a process start time', () => {
      expect(attributeServer(row, facts({ processStartMs: () => null }))).toBe('unknown');
    });

    it('refuses a row with no usable recorded timestamp rather than guessing', () => {
      expect(attributeServer({ ...row, startedAt: null }, facts())).toBe('unknown');
      expect(attributeServer({ ...row, startedAt: 'whenever' }, facts())).toBe('unknown');
    });
  });
});
