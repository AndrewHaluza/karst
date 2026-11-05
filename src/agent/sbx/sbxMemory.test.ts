import { describe, expect, it } from 'vitest';
import { resolveMinFreeBytes, resolveSbxMemory, waitingNote } from './sbxMemory.js';

const GB = 1024 ** 3;

describe('resolveSbxMemory', () => {
  it('defaults to 40% of host RAM: 16 GB → 6553m', () => expect(resolveSbxMemory(16 * GB)).toBe('6553m'));
  it('clamps to 2 GB on a small host and 8 GB on a big one', () => {
    expect(resolveSbxMemory(4 * GB)).toBe('2g');
    expect(resolveSbxMemory(64 * GB)).toBe('8g');
  });
  it('an override wins but is capped at 85% of host RAM', () => {
    expect(resolveSbxMemory(16 * GB, '3g')).toBe('3g');
    expect(resolveSbxMemory(8 * GB, '12g')).toBe('6963m');
  });
  it('unknown host RAM: the override as written, else the fallback', () => {
    expect(resolveSbxMemory(undefined, '5g')).toBe('5g');
    expect(resolveSbxMemory(undefined)).toBe('4g');
    expect(resolveSbxMemory(Number.NaN)).toBe('4g');
  });
});

describe('admission threshold and note', () => {
  it('defaults to 1.5 GB, override in Docker grammar', () => {
    expect(resolveMinFreeBytes()).toBe(1.5 * GB);
    expect(resolveMinFreeBytes('2g')).toBe(2 * GB);
  });
  it('words the wait', () => expect(waitingNote(0.8 * GB, 1.5 * GB)).toBe('Waiting for memory (free 0.8 GB, needs 1.5 GB)'));
});
