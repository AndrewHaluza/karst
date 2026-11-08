import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { guestMemoryScript } from './sbxGuestMemory.js';

describe('guestMemoryScript shell syntax', () => {
  it('passes sh -n', () => {
    const res = spawnSync('sh', ['-n', '-c', guestMemoryScript()], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });
});
