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
});
