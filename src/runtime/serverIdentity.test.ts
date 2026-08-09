import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attributeServer,
  parseStartedAt,
  processStartMsAsync,
  systemAsyncProcessFacts,
  systemProcessFacts,
  type ProcessFacts,
  type LiveCwd,
} from './serverIdentity.js';
import { canonicalPath } from './pathScope.js';

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

describe('processStartMsAsync', () => {
  it('reads a Windows process creation time through bounded PowerShell output', async () => {
    const calls: { command: string; args: string[] }[] = [];
    const run = async (command: string, args: string[]): Promise<string> => {
      calls.push({ command, args });
      return '2026-08-03T07:00:00.0000000Z\r\n';
    };

    const startedAt = await processStartMsAsync(4242, 'win32', run);

    expect(startedAt).toBe(RECORDED_START);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('powershell.exe');
    expect(calls[0]!.args.join(' ')).toContain('4242');
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

  describe('with a cwd probe (Linux /proc, macOS lsof)', () => {
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

    // The OS answers the cwd probe, but a pre-v21 row never recorded where the
    // server runs — there is nothing to compare against, so the probe is not
    // evidence EITHER WAY. The decision must fall through to the start-time
    // rule rather than refuse on a question the row cannot answer: before the
    // lsof probe gave macOS a cwd answer, those rows were attributable by
    // start time, and gaining a probe must not strand them.
    it('falls through to the start-time rule when the row has no recorded directory', () => {
      const f = facts({ liveCwd: () => ({ path: '/w/abc', deleted: false }) });
      expect(attributeServer({ ...row, cwd: null }, f)).toBe('attributable'); // start time matches
    });

    it('refuses when the row has no recorded directory AND no start time is usable', () => {
      const f = facts({
        liveCwd: () => ({ path: '/w/abc', deleted: false }),
        processStartMs: () => null,
      });
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

  describe('without a cwd probe (Windows, or a missing lsof)', () => {
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

describe('systemProcessFacts (real OS probes)', () => {
  it('reports the live cwd of a running process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-cwd-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], {
      cwd: dir,
      stdio: 'ignore',
    });
    try {
      const live = systemProcessFacts.liveCwd(child.pid!);
      const asyncLive = await systemAsyncProcessFacts.liveCwd(child.pid!);
      if (process.platform === 'linux') {
        // /proc readlink always answers.
        expect(live).not.toBeNull();
        expect(canonicalPath(live!.path)).toBe(canonicalPath(dir));
        expect(asyncLive).not.toBeNull();
        expect(canonicalPath(asyncLive!.path)).toBe(canonicalPath(dir));
      } else if (process.platform === 'darwin') {
        // lsof ships with macOS; where it is missing the probe degrades to
        // null (evidence not obtained), so there is nothing to assert then.
        if (live) expect(canonicalPath(live.path)).toBe(canonicalPath(dir));
        if (asyncLive) expect(canonicalPath(asyncLive.path)).toBe(canonicalPath(dir));
      } else {
        // Windows has neither /proc nor lsof by default.
        expect(live).toBeNull();
        expect(asyncLive).toBeNull();
      }
    } finally {
      child.kill('SIGKILL');
    }
  });
});
