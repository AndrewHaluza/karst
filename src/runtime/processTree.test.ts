import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { killTree } from './processTree.js';

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

describe('killTree', () => {
  it('uses Windows taskkill recursively without blocking', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const killer = new EventEmitter();
    spawnMock.mockReturnValue(killer);
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killTree(412);

    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '412', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );
    expect(signal).not.toHaveBeenCalled();
  });

  it('falls back to a direct kill when Windows taskkill exits nonzero', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const killer = new EventEmitter();
    spawnMock.mockReturnValue(killer);
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killTree(413);
    killer.emit('close', 1);

    expect(signal).toHaveBeenCalledWith(413, 'SIGKILL');
  });

  it('falls back to a direct kill when Windows taskkill cannot spawn', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const killer = new EventEmitter();
    spawnMock.mockReturnValue(killer);
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killTree(414);
    killer.emit('error', new Error('ENOENT'));

    expect(signal).toHaveBeenCalledWith(414, 'SIGKILL');
  });

  it('reports Windows as unknown — taskkill is fired and forgotten', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    spawnMock.mockReturnValue(new EventEmitter());
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(killTree(415)).toBe('unknown');
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
