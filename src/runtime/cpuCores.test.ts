import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock node:os module before importing
vi.mock('node:os', () => ({
  cpus: vi.fn(),
}));

import { getCpuCoreCount, __resetCpuCoreCountCache } from './cpuCores.js';
import { cpus } from 'node:os';

describe('getCpuCoreCount', () => {
  beforeEach(() => {
    __resetCpuCoreCountCache();
    vi.resetAllMocks();
  });

  it('returns a positive integer', () => {
    const count = getCpuCoreCount();
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThan(0);
    expect(Number.isInteger(count)).toBe(true);
  });

  it('uses os.cpus().length when available', () => {
    vi.mocked(cpus).mockReturnValue([{}, {}, {}, {}] as any); // 4 cores
    expect(getCpuCoreCount()).toBe(4);
  });

  it('falls back to 1 when os.cpus is unavailable', () => {
    vi.mocked(cpus).mockReturnValue(undefined as any);
    expect(getCpuCoreCount()).toBe(1);
  });

  it('falls back to 1 when os.cpus returns empty array', () => {
    vi.mocked(cpus).mockReturnValue([] as any);
    expect(getCpuCoreCount()).toBe(1);
  });

  it('falls back to 1 when os.cpus throws', () => {
    vi.mocked(cpus).mockImplementation(() => { throw new Error('unavailable'); });
    expect(getCpuCoreCount()).toBe(1);
  });
});