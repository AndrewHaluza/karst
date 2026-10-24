import { describe, expect, it } from 'vitest';
import { FALLBACK_MEMORY_LIMITS, queryDockerMemTotal, resolveDockerMemoryLimits } from './dockerMemory.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe('resolveDockerMemoryLimits', () => {
  it('falls back to fixed limits when MemTotal is unknown', () => {
    expect(resolveDockerMemoryLimits(undefined)).toEqual({
      interactiveMemory: '2g', interactiveReservation: '1g', gateMemory: '3g', gateReservation: '1536m',
    });
    expect(resolveDockerMemoryLimits(undefined)).toEqual(FALLBACK_MEMORY_LIMITS);
    expect(resolveDockerMemoryLimits(0)).toEqual(FALLBACK_MEMORY_LIMITS);
    expect(resolveDockerMemoryLimits(Number.NaN)).toEqual(FALLBACK_MEMORY_LIMITS);
  });

  it('scales down on a 4.8 GB VM', () => {
    // 4915 MB: 45% = 2211, 25% = 1228, 55% = 2703, 30% = 1474
    expect(resolveDockerMemoryLimits(4915 * MB)).toEqual({
      interactiveMemory: '2211m', interactiveReservation: '1228m', gateMemory: '2703m', gateReservation: '1474m',
    });
  });

  it('hits the upper clamps on a 16 GB VM', () => {
    expect(resolveDockerMemoryLimits(16 * GB)).toEqual({
      interactiveMemory: '4096m', interactiveReservation: '2048m', gateMemory: '6144m', gateReservation: '3072m',
    });
  });

  it('raises tiny VMs to the lower clamps, then caps them at 85% of the VM', () => {
    // 1 GB VM: ceiling 870 MB; every floor (512..1536) is capped to it except the 512 reservation.
    expect(resolveDockerMemoryLimits(1024 * MB)).toEqual({
      interactiveMemory: '870m', interactiveReservation: '512m', gateMemory: '870m', gateReservation: '768m',
    });
  });

  it('keeps an explicit override verbatim when it fits', () => {
    expect(resolveDockerMemoryLimits(16 * GB, { gateMemory: '8g', interactiveReservation: '768M' })).toMatchObject({
      gateMemory: '8g', interactiveReservation: '768M', interactiveMemory: '4096m',
    });
  });

  it('clamps an override above 85% of the VM', () => {
    // 4096 MB VM: ceiling floor(4096 * 0.85) = 3481
    expect(resolveDockerMemoryLimits(4096 * MB, { gateMemory: '6g' }).gateMemory).toBe('3481m');
  });

  it('applies an override as-is when the VM size is unknown', () => {
    expect(resolveDockerMemoryLimits(undefined, { gateMemory: '8g' })).toEqual({ ...FALLBACK_MEMORY_LIMITS, gateMemory: '8g' });
  });
});

describe('queryDockerMemTotal', () => {
  const query = (answer: object) => queryDockerMemTotal(fakeDockerProcess({ "docker info --format {{.MemTotal}}": answer }));

  it('reads the byte count', async () => {
    const proc = fakeDockerProcess({ 'docker info --format {{.MemTotal}}': { stdout: '5154832384\n' } });
    await expect(queryDockerMemTotal(proc)).resolves.toBe(5154832384);
  });

  it.each([{ stdout: 'oops' }, { stdout: '0' }, { stdout: '12', code: 1 }])('is undefined for %j', async (answer) => {
    await expect(query(answer)).resolves.toBeUndefined();
  });

  it('is undefined when the process throws', async () => {
    await expect(queryDockerMemTotal({ run: () => Promise.reject(new Error('x')), pipe: () => Promise.reject(new Error('x')) })).resolves.toBeUndefined();
  });
});
