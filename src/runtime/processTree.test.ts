import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

import { killTree } from './processTree.js';

/** The Windows `taskkill` result shape, with only the fields killTree reads. */
function taskkill(status: number | null, error?: Error): { status: number | null; error?: Error } {
  return error ? { status, error } : { status };
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnSyncMock.mockReset();
});

describe('killTree', () => {
  // The Windows leak this ticket closes: the old implementation fired taskkill
  // async and always returned 'unknown', so a caller that mapped "not denied"
  // to "killed" erased the row while the process was still alive. taskkill is
  // now synchronous, so the exit status is a real answer.
  describe('Windows outcomes', () => {
    it('reports killed when taskkill /T exits 0, without a redundant direct signal', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      spawnSyncMock.mockReturnValue(taskkill(0));
      const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);

      expect(killTree(412)).toBe('killed');

      expect(spawnSyncMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '412', '/t', '/f'],
        { stdio: 'ignore', windowsHide: true, timeout: 5_000 },
      );
      expect(signal).not.toHaveBeenCalled();
    });

    it('reports killed when taskkill fails but the direct signal lands', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      spawnSyncMock.mockReturnValue(taskkill(1));
      const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);

      expect(killTree(413)).toBe('killed');
      expect(signal).toHaveBeenCalledWith(413, 'SIGKILL');
    });

    it('reports denied when taskkill is refused and the direct signal is EPERM — still running', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      spawnSyncMock.mockReturnValue(taskkill(1));
      const eperm = Object.assign(new Error('Access is denied'), { code: 'EPERM' });
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw eperm;
      });

      expect(killTree(414)).toBe('denied');
    });

    it('reports denied when taskkill cannot spawn and the direct signal is EPERM', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      spawnSyncMock.mockReturnValue(taskkill(null, new Error('ENOENT')));
      const eperm = Object.assign(new Error('Access is denied'), { code: 'EPERM' });
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw eperm;
      });

      expect(killTree(415)).toBe('denied');
    });

    it('reports killed when taskkill fails and the target is already gone (ESRCH)', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      spawnSyncMock.mockReturnValue(taskkill(128));
      const esrch = Object.assign(new Error('No such process'), { code: 'ESRCH' });
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw esrch;
      });

      expect(killTree(416)).toBe('killed');
    });
  });

  // The distinction this ticket exists to make: ESRCH means the goal (nothing
  // running) was already true; EPERM means it very much is NOT true, and a
  // caller that reads both as success leaves a live, still-running process
  // behind while believing it stopped it.
  describe('POSIX outcomes', () => {
    it('reports killed when the group signal succeeds', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      vi.spyOn(process, 'kill').mockImplementation(() => true);

      expect(killTree(500)).toBe('killed');
    });

    it('reports killed when the group is already gone (ESRCH) and the fallback single-pid kill also finds nothing', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const esrch = Object.assign(new Error('No such process'), { code: 'ESRCH' });
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw esrch;
      });

      expect(killTree(501)).toBe('killed');
    });

    it('reports denied when the group signal is refused (EPERM) — the process is still running', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const eperm = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw eperm;
      });

      expect(killTree(502)).toBe('denied');
    });

    it('reports denied when the group is gone but the fallback single-pid kill is refused', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      const esrch = Object.assign(new Error('No such process'), { code: 'ESRCH' });
      const eperm = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      const signal = vi.spyOn(process, 'kill');
      signal.mockImplementationOnce(() => {
        throw esrch;
      });
      signal.mockImplementationOnce(() => {
        throw eperm;
      });

      expect(killTree(503)).toBe('denied');
    });
  });
});
