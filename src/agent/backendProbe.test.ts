import { describe, expect, it } from 'vitest';
import { probeDockerDisk } from './backendProbe.js';
import type { SbxProcess } from './sbx/sbxProcess.js';

const proc = (code: number, stdout: string): SbxProcess => ({ run: async () => ({ code, stdout, stderr: '' }) });

describe('probeDockerDisk', () => {
  it('sums the container sizes', async () => {
    expect(await probeDockerDisk(proc(0, '1GB (virtual 2GB)\n500MB (virtual 1GB)\n'))).toBeCloseTo(1.5e9, -3);
  });
  it('is 0 with no containers', async () => {
    expect(await probeDockerDisk(proc(0, ''))).toBe(0);
  });
  it('is undefined when docker fails', async () => {
    expect(await probeDockerDisk(proc(1, ''))).toBeUndefined();
  });
  it('is undefined on unparseable output', async () => {
    expect(await probeDockerDisk(proc(0, 'weird\n'))).toBeUndefined();
  });
  it('is undefined when the process throws', async () => {
    expect(await probeDockerDisk({ run: async () => { throw new Error('x'); } })).toBeUndefined();
  });
});
