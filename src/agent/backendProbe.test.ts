import { describe, expect, it } from 'vitest';
import { dockerKillContext, probeDockerDisk, probeDockerMemory } from './backendProbe.js';
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

describe('probeDockerMemory', () => {
  it('reads the MemTotal bytes', async () => {
    expect(await probeDockerMemory(proc(0, '5154000000\n'))).toBe(5154000000);
  });
  it('asks docker info for MemTotal', async () => {
    const calls: string[][] = [];
    await probeDockerMemory({ run: async (c, a) => { calls.push([c, ...a]); return { code: 0, stdout: '1', stderr: '' }; } });
    expect(calls).toEqual([['docker', 'info', '--format', '{{.MemTotal}}']]);
  });
  it.each([[1, '5'], [0, ''], [0, 'abc'], [0, '0'], [0, '-4']])('is undefined for code %i stdout %j', async (code, out) => {
    expect(await probeDockerMemory(proc(code, out))).toBeUndefined();
  });
  it('is undefined when the process throws', async () => {
    expect(await probeDockerMemory({ run: async () => { throw new Error('x'); } })).toBeUndefined();
  });
});

describe('dockerKillContext', () => {
  const GB = 2 ** 30;
  const multi = (info: { code: number; stdout: string }, ps: { code: number; stdout: string } | 'throw'): SbxProcess => ({
    run: async (_c, a) => {
      if (a[0] === 'info') return { ...info, stderr: '' };
      if (ps === 'throw') throw new Error('x');
      return { ...ps, stderr: '' };
    },
  });
  it('names the VM memory and counts karst/playwright containers', async () => {
    const ps = { code: 0, stdout: 'karst-a img\nweb nginx\nrunner mcr.microsoft.com/Playwright:v1\n' };
    expect(await dockerKillContext(multi({ code: 0, stdout: String(4.8 * GB) }, ps))).toBe('Docker VM 4.8 GB, 2 karst/playwright containers running');
  });
  it('singular for one container', async () => {
    expect(await dockerKillContext(multi({ code: 0, stdout: String(8 * GB) }, { code: 0, stdout: 'karst-a img\n' }))).toBe('Docker VM 8.0 GB, 1 karst/playwright container running');
  });
  it('zero containers is still reported', async () => {
    expect(await dockerKillContext(multi({ code: 0, stdout: String(8 * GB) }, { code: 0, stdout: '' }))).toBe('Docker VM 8.0 GB, 0 karst/playwright containers running');
  });
  it('drops the container part when ps fails or throws', async () => {
    expect(await dockerKillContext(multi({ code: 0, stdout: String(8 * GB) }, { code: 1, stdout: '' }))).toBe('Docker VM 8.0 GB');
    expect(await dockerKillContext(multi({ code: 0, stdout: String(8 * GB) }, 'throw'))).toBe('Docker VM 8.0 GB');
  });
  it('drops the memory part when info fails', async () => {
    expect(await dockerKillContext(multi({ code: 1, stdout: '' }, { code: 0, stdout: 'karst-a x\n' }))).toBe('1 karst/playwright container running');
  });
  it('is undefined when nothing is readable', async () => {
    expect(await dockerKillContext(multi({ code: 1, stdout: '' }, { code: 1, stdout: '' }))).toBeUndefined();
  });
});
