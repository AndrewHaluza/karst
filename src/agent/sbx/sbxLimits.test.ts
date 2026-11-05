import { describe, expect, it } from 'vitest';
import { limitEnvEntries, limitEnvArgs, resolveGateSlots, resolveSbxCpus, resolveSbxLimits, SBX_CPUS_MAX } from './sbxLimits.js';

describe('resolveSbxCpus', () => {
  it('defaults to half the host CPUs, at least 2, at most 4', () => {
    expect(resolveSbxCpus(10)).toBe(4);
    expect(resolveSbxCpus(6)).toBe(3);
    expect(resolveSbxCpus(4)).toBe(2);
    expect(resolveSbxCpus(2)).toBe(2);
    expect(resolveSbxCpus(1)).toBe(2);
    expect(resolveSbxCpus(64)).toBe(SBX_CPUS_MAX);
  });
  it('uses 2 when the host CPU count is unknown', () => {
    expect(resolveSbxCpus(undefined)).toBe(2);
    expect(resolveSbxCpus(Number.NaN)).toBe(2);
  });
  it('lets a manifest override win, even above the clamp', () => {
    expect(resolveSbxCpus(10, 8)).toBe(8);
    expect(resolveSbxCpus(10, 1)).toBe(1);
  });
});

describe('limitEnvEntries', () => {
  it('sets the worker counts and a heap of 50% of the memory limit', () => {
    expect(limitEnvEntries({ cpus: 3, memory: '4g' })).toEqual([
      ['VITEST_MAX_THREADS', '3'],
      ['VITEST_MAX_FORKS', '3'],
      ['NODE_OPTIONS', '--max-old-space-size=2048'],
    ]);
  });
  it('appends to an existing NODE_OPTIONS and never replaces it', () => {
    const e = limitEnvEntries({ cpus: 2, memory: '2g', nodeOptions: '--enable-source-maps' });
    expect(e).toContainEqual(['NODE_OPTIONS', '--enable-source-maps --max-old-space-size=1024']);
  });
  it('keeps a heap limit the user already set', () => {
    const e = limitEnvEntries({ cpus: 2, memory: '2g', nodeOptions: '--max-old-space-size=512' });
    expect(e).toContainEqual(['NODE_OPTIONS', '--max-old-space-size=512']);
  });
  it('handles megabyte memory strings', () => {
    const e = limitEnvEntries({ cpus: 2, memory: '1536m' });
    expect(e).toContainEqual(['NODE_OPTIONS', '--max-old-space-size=768']);
  });
  it('sets no heap when the memory limit is unknown', () => {
    expect(limitEnvEntries({ cpus: 2 }).map(([k]) => k)).toEqual(['VITEST_MAX_THREADS', 'VITEST_MAX_FORKS']);
  });
  it('sets nothing on opt-out', () => {
    expect(limitEnvEntries({ cpus: 2, memory: '4g', optOut: true })).toEqual([]);
  });
});

describe('limitEnvArgs', () => {
  it('renders --env KEY=VALUE pairs', () => {
    expect(limitEnvArgs({ cpus: 2 })).toEqual(['--env', 'VITEST_MAX_THREADS=2', '--env', 'VITEST_MAX_FORKS=2']);
  });
});

describe('resolveSbxLimits and resolveGateSlots', () => {
  it('maps the manifest to runner options', () => {
    expect(resolveSbxLimits(10)).toEqual({ cpus: 4, limitWorkers: true });
    expect(resolveSbxLimits(10, { cpus: 2, workers: false })).toEqual({ cpus: 2, limitWorkers: false });
  });
  it('defaults to 2 gate slots; 0 stays 0', () => {
    expect(resolveGateSlots()).toBe(2);
    expect(resolveGateSlots({ gateSlots: 0 })).toBe(0);
    expect(resolveGateSlots({ gateSlots: 5 })).toBe(5);
  });
});
