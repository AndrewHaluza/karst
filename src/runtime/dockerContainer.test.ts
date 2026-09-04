import { describe, it, expect, vi } from 'vitest';
import type { spawn as SpawnFn } from 'node:child_process';
import { removeContainer } from './dockerContainer.js';

/** A child that records what was asked of it and can raise a spawn error. */
function fakeChild() {
  const handlers: Record<string, (err?: unknown) => void> = {};
  return {
    once: (event: string, fn: (err?: unknown) => void) => {
      handlers[event] = fn;
      return undefined;
    },
    unref: vi.fn(),
    emit: (event: string, err?: unknown) => handlers[event]?.(err),
  };
}

describe('removeContainer', () => {
  it('forces removal by name, detached and unref’d', () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof SpawnFn;
    removeContainer('karst-t1-db', { spawnFn });

    expect(spawnFn).toHaveBeenCalledWith(
      'docker',
      ['rm', '-f', 'karst-t1-db'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    // Unref'd: cleanup must never hold the extension host open.
    expect(child.unref).toHaveBeenCalled();
  });

  it('swallows a spawn error rather than throwing into the host', () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof SpawnFn;
    removeContainer('karst-t1-db', { spawnFn });
    // An 'error' event with no listener THROWS in node. docker may simply not
    // be installed; that must not take down the stop path.
    expect(() => child.emit('error', new Error('spawn docker ENOENT'))).not.toThrow();
  });

  it('never throws when the spawn itself fails', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('EACCES');
    }) as unknown as typeof SpawnFn;
    expect(() => removeContainer('karst-t1-db', { spawnFn })).not.toThrow();
  });

  it('reports the removal through the injected debug callback', () => {
    const debug = vi.fn();
    const spawnFn = vi.fn(() => fakeChild()) as unknown as typeof SpawnFn;
    removeContainer('karst-t1-db', { spawnFn, debug });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('[runtime]'));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('karst-t1-db'));
  });
});
